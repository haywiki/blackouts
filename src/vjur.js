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

    async #loadOutages() {
        await this.#handleUrl('https://interactive.vjur.am');
        await this.#handleUrl('https://interactive.vjur.am/?ajax=list-post&page=2');
        await this.#handleUrl('https://interactive.vjur.am/?ajax=list-post&page=3');
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
                allowedTags: [ 'b', 'i', 'em', 'u', 'strong', 'a' ],
                allowedAttributes: {
                    'a': [ 'href' ]
                },
                allowedIframeHostnames: [ ]
            });
            body = body.replace(/^[ \t]+/gm, '').trim();
            this.outages.push({
                hash: getSHA256ofJSON(body),
                title: title,
                body: body,
            });
        }
        return outages;
    }

    async reportNewOutages(reportFunc) {
        await this.#loadOutages()

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
    }
}

module.exports = VjurParser;
