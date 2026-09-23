import { DurableObject } from 'cloudflare:workers';
import { AIBudgetState } from './ai-budget.js';

export { default } from './worker.js';

export class AIBudget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.budget = new AIBudgetState(ctx);
  }

  acquire() { return this.budget.acquire(); }
  release(leaseId) { return this.budget.release(leaseId); }
}
