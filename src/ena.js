// noinspection JSAssignmentUsedAsCondition

const cheerio = require("cheerio");
const sanitizeHtml = require("sanitize-html");
const crypto = require('crypto');
const getSHA256ofJSON = (input) => crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
const moment = require('moment');
const natsort = require('natsort').default;
const PgQuery = require('dv-pg-query');

class EnaParser {
    today = moment().format('YYYY-MM-DD')
    outages = [ ]

    constructor(dbConfig) {
        this.db = new PgQuery(dbConfig);
    }

    async #loadOutages($) {
        let outages = $('#ctl00_ContentPlaceHolder1_attenbody').html();
        outages = sanitizeHtml(outages.replaceAll('</p>', "</p>\n"), {
            allowedTags: [ 'b', 'i', 'u', 'a', 'strong' ],
            allowedAttributes: {
                'a': [ 'href' ]
            },
            allowedIframeHostnames: [ ]
        }).replace(/<u>\s*<\/u>/g, ' ').replace(/^ +/gm, '').trim();
        for (let outage of outages.split(/^\*{3,}$/m)) {
            let outageMessage = '';
            for (let part of outage.trim().split("\n\n")) {
                if (outageMessage.length + part.length < 4000) {
                    outageMessage += "\n\n" + part;
                } else {
                    this.outages.push(outageMessage.trim());
                    outageMessage = part;
                }
            }
            if (outageMessage) {
                this.outages.push(outageMessage.trim());
            }
        }
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
        // noinspection JSUnresolvedFunction
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
        const emergencies = await this.db.fetchAll('select * from ena_emergency where started_time >= \'2022-11-07\' and finished_time is null order by started_time, id');
        if (!emergencies) {
            return;
        }
        let lines = [ ];
        for (let emergency of emergencies) {
            let line = '';
            if (emergency.finished_time) line += '<s>';
            line += moment(emergency.started_time).format('HH:mm');
            if (emergency.finished_time) line += '..' + moment(emergency.finished_time).format('HH:mm');
            line += ' ' + emergency['title'];
            if (emergency.finished_time) line += '</s>';
            lines.push(line);
        }
        let lines2 = { };
        for (let line of lines) {
            let match;
            if (match = line.match(/^(\d{2}:\d{2} [а-я]\.[А-Я]+, .+ (ул\.|шоссе|кварт\.)) (.+)$/)) {
                if (!lines2[match[1]]) {
                    lines2[match[1]] = { prefix: match[1], objects: [ ], strike: false }
                }
                lines2[match[1]]['objects'].push(match[3]);
            } else if (match = line.match(/^(\d{2}:\d{2} [^,]+), (.+)$/)) {
                if (!lines2[match[1]]) {
                    lines2[match[1]] = { prefix: match[1], objects: [ ], strike: false }
                }
                lines2[match[1]]['objects'].push(match[2]);
            } else {
                lines2[line] = { prefix: line, objects: [ ], strike: false };
            }
        }
        let lines3 = [ ];
        for (let line2 of Object.values(lines2)) {
            line2.objects.sort(natsort());
            if (!line2.strike) {
                lines3.push(line2.prefix + (line2.objects.length > 0 ? ': ' + line2.objects.join(', ') : ''));
            }
        }

        let report = "Аварийные отключения электричества <b>" + moment().format('DD.MM.YYYY') + "</b>\n\n" + lines3.join("\n");
        const hash = getSHA256ofJSON(report);
        report += "\n\nОбновлено " + moment().format('HH:mm DD.MM.YYYY');

        try {
            let row = await this.db.fetchOne('select id, hash, telegram_msg_id from ena_message where message_group = $1 order by create_time desc limit 1', [ this.today ]);
            if (row && row.hash === hash) {
                console.log('ena > emergency > already published');
            } else if (row && row.telegram_msg_id) {
                await reportFunc(report, row.telegram_msg_id);
                await this.db.insert('ena_message', { hash: hash, body: report, message_group: this.today, telegram_msg_id: row.telegram_msg_id });
                console.log('ena > emergency > updated');
            } else {
                const response = await reportFunc(report);
                await this.db.insert('ena_message', { hash: hash, body: report, message_group: this.today, telegram_msg_id: response.message_id });
                console.log('ena > emergency > published');
            }
        } catch (e) {
            console.log(e);
        }

    }
}

module.exports = EnaParser;
