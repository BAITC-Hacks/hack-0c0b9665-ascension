import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTelegramTransport } from './complaints/telegram.js';

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (!token) {
    console.error('Меню не настроено: задайте TELEGRAM_BOT_TOKEN в локальном окружении.');
    process.exitCode = 1;
    return;
  }
  const result = await createTelegramTransport({ token }).configureMenu();
  console.log(`Меню Telegram настроено: ${result.commandCount} команд, кнопка меню и описание бота.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Не удалось настроить меню Telegram. Проверьте токен и соединение с Telegram.');
    process.exitCode = 1;
  });
}
