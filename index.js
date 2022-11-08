require('dotenv').config();
const { Telegraf } = require('telegraf');
const {Translate} = require('@google-cloud/translate').v2;
const translate = new Translate({ projectId: process.env.GOOGLE_TRANSLATE_PROJECT_ID });
const enaParser = new (require('./src/ena'))({ dsn: process.env.PG_DSN, maxPoolSize: 2 });
const vjurParser = new (require('./src/vjur'))({ dsn: process.env.PG_DSN, maxPoolSize: 2 }, translate);

const bot = new Telegraf(process.env.TELEGRAM_BOT_KEY);
// bot.start((ctx) => ctx.reply('Welcome'));
// bot.help((ctx) => ctx.reply('Send me a sticker'));
// bot.on('sticker', (ctx) => ctx.reply('👍'));
// bot.hears('hi', (ctx) => ctx.reply('Hey there'));
// bot.launch();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

async function reportToTelegram(messageHtml, messageId) {
    if (messageId) {
        return await bot.telegram.editMessageText(process.env.TELEGRAM_CHANNEL, messageId, null, messageHtml, { parse_mode: 'HTML' });
    } else {
        return await bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL, messageHtml, { parse_mode: 'HTML' });
    }
}

(async () => {
    await enaParser.reportNewOutages(reportToTelegram);
    await vjurParser.reportNewOutages(reportToTelegram);
})();
