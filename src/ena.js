const cheerio = require("cheerio");
const sanitizeHtml = require("sanitize-html");
const crypto = require('crypto');
const getSHA256ofJSON = (input) => crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
const moment = require('moment');
const PgQuery = require('dv-pg-query');

class EnaParser {
    today = moment().format('YYYY-MM-DD')
    outages = [ ]

    constructor(dbConfig) {
        this.db = new PgQuery(dbConfig);
    }

    async #loadOutages($) {
        let outages = $('#ctl00_ContentPlaceHolder1_attenbody').html();
        outages = outages.replaceAll('<!--[endif]-->', '')
            .replaceAll('<o:p></o:p>', '')
            .replace(/<p>\s*<\/p>/g, '')
            .replace(/<strong>\s*<\/strong>/g, '')
            .replace(/<u>\s*<\/u>/g, '').replace(/<strong>\s*<\/strong>/g, '')
            .replaceAll('</p>', "</p>\n");
        outages = sanitizeHtml(outages, {
            allowedTags: [ 'b', 'i', 'em', 'u', 'strong', 'a' ],
            allowedAttributes: {
                'a': [ 'href' ]
            },
            allowedIframeHostnames: [ ]
        });
        this.outages = outages.replace(/^ +/gm, '').split(/^\*{3,}$/m);
    }

    async #loadEmergencies($) {
        await this.db.execute('begin');
        await this.db.execute('update ena_emergency set finished_time = now() where finished_time is null');
        for (let row of $('#ctl00_ContentPlaceHolder1_vtarayin tr')) {
            const time = $(row).find('td').eq(0).text();
            if (!time) continue;
            let date = moment(time, 'DD.MM.YYYY HH:mm', 'ru').format('YYYY-MM-DD HH:mm');
            let address = $(row).find('td').eq(1).text();
            await this.db.upsert('ena_emergency', { finished_time: null }, { started_time: date, title: address });
        }
        await this.db.execute('commit');
    }

    async reportNewOutages(reportFunc) {
        const res = await fetch('https://www.ena.am/Info.aspx?id=5&lang=3');
        if (!res.ok) {
            return null;
        }
        const $ = cheerio.load(await res.text());
        await this.#loadOutages($);
        await this.#loadEmergencies($);
        await this.#reportOutages(reportFunc);
        await this.#reportEmergencies(reportFunc);
    }

    async #reportOutages(reportFunc) {
        for (let outageBody of this.outages) {
            const hash = getSHA256ofJSON(outageBody);
            let row = await this.db.fetchOne('select id from ena_message where hash = $1', [ hash ]);
            if (row && row.id) {
                console.log('ena > planned > ' + hash + ' > already published');
                continue;
            }
            const response = await reportFunc(outageBody);
            await this.db.insert('ena_message', { hash: hash, body: outageBody, telegram_msg_id: response.message_id });
            console.log('ena > planned > ' + hash + ' > published');
        }
    }

    async #reportEmergencies(reportFunc) {
        const emergencies = await this.db.fetchAll('select * from ena_emergency where started_time >= date(now())');
        if (!emergencies) {
            return;
        }
        let report = "Аварийные отключения электричества <b>" + moment().format('DD.MM.YYYY') + "</b>\n\n";
        for (let emergency of emergencies) {
            if (emergency.finished_time) report += '<s>';
            report += moment(emergency.started_time).format('HH:mm');
            if (emergency.finished_time) report += '..' + moment(emergency.finished_time).format('HH:mm');
            report += ' ' + emergency['title'];
            if (emergency.finished_time) report += '</s>';
            report += "\n";
        }
        const hash = getSHA256ofJSON(report);
        report += "\nОбновлено " + moment().format('HH:mm DD.MM.YYYY');

        let row = await this.db.fetchOne('select id, hash, telegram_msg_id from ena_message where message_group = $1 order by create_time desc limit 1', [ this.today ]);
        if (row && row.hash === hash) {
            console.log('ena > emergency > already published');
        } else if (row && row.telegram_msg_id) {
            const response = await reportFunc(report, row.telegram_msg_id);
            await this.db.insert('ena_message', { hash: hash, body: report, message_group: this.today, telegram_msg_id: row.telegram_msg_id });
            console.log('ena > emergency > updated');
        } else {
            const response = await reportFunc(report);
            await this.db.insert('ena_message', { hash: hash, body: report, message_group: this.today, telegram_msg_id: response.message_id });
            console.log('ena > emergency > published');
        }
    }
}

module.exports = EnaParser;
