export const DEFAULT_NVIDIA_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
export const DEFAULT_CLOUDFLARE_NVIDIA_MODEL = '@cf/nvidia/nemotron-3-120b-a12b';

/** Resolve one provider only: a missing NVIDIA key never falls through to another account. */
export function resolveAIConfiguration(options = {}, env = globalThis.process?.env ?? {}) {
  const rawProvider = options.provider ?? env.AI_PROVIDER ?? 'openai';
  const selected = typeof rawProvider === 'string' ? rawProvider.trim().toLowerCase() || 'openai' : '';
  const provider = selected === 'nvidia-cloudflare' ? 'nvidia' : selected;
  const bindingBackend = selected === 'nvidia-cloudflare' || (provider === 'nvidia' && options.backend === 'cloudflare');
  const aiBinding = Object.hasOwn(options, 'aiBinding') ? options.aiBinding : env.AI;
  const knownProvider = ['openai', 'nvidia'].includes(provider);
  const apiKey = knownProvider && !bindingBackend
    ? options.apiKey ?? (provider === 'nvidia' ? env.NVIDIA_API_KEY : env.OPENAI_API_KEY) ?? '' : '';
  const model = options.model ?? (provider === 'nvidia'
    ? bindingBackend ? env.CF_NVIDIA_MODEL || DEFAULT_CLOUDFLARE_NVIDIA_MODEL : env.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL
    : env.OPENAI_MODEL ?? 'gpt-6-astra');
  const configured = knownProvider
    && (bindingBackend ? typeof aiBinding?.run === 'function' : typeof apiKey === 'string' && Boolean(apiKey.trim()))
    && typeof model === 'string' && Boolean(model.trim()) && model.length <= 120;
  return { provider, apiKey, model, configured, ...(bindingBackend ? { backend: 'cloudflare', aiBinding } : {}) };
}

/** Binding and HTTP responses share the same bounded body reader and deadline in callers. */
export async function requestProvider(configuration, request, { fetchImpl, signal } = {}) {
  if (configuration.backend === 'cloudflare') {
    if (!configuration.configured || typeof configuration.aiBinding?.run !== 'function') {
      throw new Error('AI binding is not configured');
    }
    signal?.throwIfAborted();
    const { model: _model, ...input } = request.body;
    // The caller also races a deadline in case the binding ignores cancellation.
    const response = await configuration.aiBinding.run(configuration.model, input,
      { returnRawResponse: true, ...(signal ? { signal } : {}) });
    if (signal?.aborted) {
      try { await response.body?.cancel?.(); } catch { /* Preserve timeout. */ }
      signal.throwIfAborted();
    }
    return response;
  }
  return (fetchImpl ?? fetch)(request.url, {
    method: 'POST', headers: { Authorization: `Bearer ${configuration.apiKey}`, 'Content-Type': 'application/json' },
    redirect: 'manual', signal, body: JSON.stringify(request.body),
  });
}

/** Keep OpenAI Responses intact; NVIDIA NIM uses non-streaming Chat Completions. */
export function createProviderRequest({ provider, backend }, body) {
  if (provider !== 'nvidia') return { url: 'https://api.openai.com/v1/responses', body };
  const system = body.input.filter(message => ['developer', 'system'].includes(message.role))
    .map(message => message.content).join('\n\n');
  // NVIDIA recommends JSON object mode with reasoning disabled for Lightning.
  // The same schema is enforced by our server; provider output is never trusted.
  const schemaInstruction = `Верни только JSON-объект без Markdown и рассуждений. Строго соблюдай JSON Schema: ${JSON.stringify(body.text.format.schema)}`;
  const constrainedSchema = structuredClone(body.text.format.schema);
  if (constrainedSchema.properties.summary) constrainedSchema.properties.summary.pattern = '^[^0-9]*$';
  for (const name of ['strengths', 'risks', 'unsupported', 'assumptions']) {
    if (constrainedSchema.properties[name]?.items) constrainedSchema.properties[name].items.pattern = '^[^0-9]*$';
  }
  if (constrainedSchema.properties.decisions?.items?.properties?.rationale) {
    constrainedSchema.properties.decisions.items.properties.rationale.pattern = '^[^0-9]*$';
  }
  return {
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    body: {
      model: body.model, stream: false, max_tokens: body.max_output_tokens,
      temperature: 0, response_format: backend === 'cloudflare'
        ? { type: 'json_schema', json_schema: { name: body.text.format.name, strict: true, schema: constrainedSchema } }
        : { type: 'json_object' },
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'system', content: `${system}\n\n${schemaInstruction}` },
        ...body.input.filter(message => !['developer', 'system'].includes(message.role))],
    },
  };
}

/** Adapt a complete final message to the existing strict, grounded response validators. */
export function normalizeProviderResponse(response, provider) {
  if (provider !== 'nvidia') return response;
  const invalid = { status: 'incomplete', output: [] };
  if (!response || !Array.isArray(response.choices) || response.choices.length !== 1) return invalid;
  const choice = response.choices[0];
  const message = choice?.message;
  if (!message || message.role !== 'assistant' || message.tool_calls?.length) return invalid;
  if (message.refusal) return { status: 'completed', output: [{ content: [{ type: 'refusal' }] }] };
  if (choice.finish_reason !== 'stop' || typeof message.content !== 'string'
    || !message.content.trim() || message.content.length > 24000) return invalid;
  return { status: 'completed', output: [{ type: 'message', content: [
    { type: 'output_text', text: message.content },
  ] }] };
}
