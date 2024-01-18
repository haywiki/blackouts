const cheerio = require("cheerio");
const sanitizeHtml = require("sanitize-html");
const crypto = require('crypto');
const getSHA256ofJSON = (input) => crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
const PgQuery = require("dv-pg-query");

class VjurParser {
    outages = [ ]

    constructor(dbConfig, log, translate) {
        this.db = new PgQuery(dbConfig);
        this.log = log;
        this.translate = translate;
    }

    async #handleUrl(url) {
        const res = await fetch(url);
        if (!res.ok) {
            return null;
        }
        const $ = cheerio.load(await res.text());
        let outages = [ ];
        for (let row of $('#list-post .panel')) {
            let title = $(row).find('.panel-heading').text().trim();
            let body  = sanitizeHtml($(row).find('.panel-body').html(), {
                allowedTags: [ 'i', 'em', 'u', 'a' ],
                allowedAttributes: { 'a': [ 'href' ] },
                allowedIframeHostnames: [ ]
            });
            body = body.replace(/^[ \t]+/gm, '').replace(/[ \u00A0]+/gm, ' ').trim();
            let truncatedBody = body
                .replace('Ընկերությունը հայցում է սպառողների ներողամտությունը պատճառված անհանգստության և կանխավ շնորհակալություն հայտնում ըմբռնման համար:', '')
                .replace('«Վեոլիա Ջուր» ընկերությունը տեղեկացնում է իր հաճախորդներին և սպառողներին, որ վթարային աշխատանքներով պայմանավորված ս.թ.', '')
                .replace(/\d{2}\.\d{2}\.\d{4}թ?$/, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            this.outages.push({
                hash: getSHA256ofJSON(body),
                title: title,
                body: truncatedBody,
            });
        }
        return outages;
    }

    async reportNewOutages(reportFunc) {
        try {
            await this.#handleUrl('https://interactive.vjur.am');
            await this.#handleUrl('https://interactive.vjur.am/?ajax=list-post&page=2');
            for (let outage of this.outages.reverse()) {
                let row = await this.db.fetchOne('select id from message_vjur where hash = $1', [ outage.hash ]);
                if (row && row.id) {
                    this.log.info('outage ' + outage.hash + ' > already published');
                    continue;
                }
                const [titleRu] = await this.translate.translate(outage.title, 'ru');
                const [bodyRu] = await this.translate.translate(outage.body, 'ru');
                const response = await reportFunc('<b>' + titleRu + '</b>\n\n' + bodyRu);
                await this.db.insert('message_vjur', {
                    hash: outage.hash, title: outage.title, body: outage.body, title_ru: titleRu, body_ru: bodyRu,
                    telegram_msg_id: response.message_id
                });
                this.log.info('outage ' + outage.hash + ' > published');
            }
        } catch (e) {
            this.log.error(e.message);
        }
    }
}

module.exports = VjurParser;
