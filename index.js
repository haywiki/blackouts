require('dotenv').config();
const { Telegraf } = require('telegraf');
const PgQuery = require("dv-pg-query");
const EnaParser = require('./src/ena');
const VjurParser = require('./src/vjur');
const {Translate} = require('@google-cloud/translate').v2;
const log = require('log');
require("log-node")();

const translate = new Translate({ projectId: process.env.GOOGLE_TRANSLATE_PROJECT_ID });
const db = new PgQuery({ dsn: process.env.PG_DSN, maxPoolSize: 2 });
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

async function iterateEna() {
    log.get('ena').info('started');
    const enaParser = new EnaParser(db, log.get('ena'));
    await enaParser.reportNewOutages(reportToTelegram);
    log.get('ena').info('finished');
    setTimeout(() => iterateEna(), 20 * 60000);
}

async function iterateVjur() {
    log.get('vjur').info('started');
    const vjurParser = new VjurParser(db, log.get('vjur'), translate);
    await vjurParser.reportNewOutages(reportToTelegram);
    log.get('vjur').info('finished');
    setTimeout(() => iterateVjur(), 5 * 60000);
}

iterateEna().then();
iterateVjur().then();
