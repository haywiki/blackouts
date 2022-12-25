// noinspection JSAssignmentUsedAsCondition

const cheerio = require("cheerio");
const sanitizeHtml = require("sanitize-html");
const crypto = require('crypto');
const getSHA256ofJSON = (input) => crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
const moment = require('moment');
const natsort = require('natsort').default;
const PgQuery = require('dv-pg-query');
const pluralize = require('pluralize-ru');

class EnaParser {
    today = moment().format('YYYY-MM-DD')
    outages = [ ]

    constructor(dbConfig, log) {
        this.db = new PgQuery(dbConfig);
        this.log = log;
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
        await this.db.execute('update ena_emergency set finished_time = now() + \'1 hour\'::interval where finished_time is null');
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
        try {
            const res = await fetch('https://www.ena.am/Info.aspx?id=5&lang=3');
            if (!res.ok) {
                return null;
            }
            const $ = cheerio.load(await res.text());
            await this.#loadOutages($);
            await this.#loadEmergencies($);
        } catch (e) {
            this.log.error(e.message);
            return;
        }
        await this.#reportOutages(reportFunc);
        await this.#reportEmergencies(reportFunc);
    }

    async #reportOutages(reportFunc) {
        for (let outageBody of this.outages) {
            if (!outageBody) {
                continue;
            }
            const hash = getSHA256ofJSON(outageBody);
            let row = await this.db.fetchOne('select id from ena_message where hash = $1', [ hash ]);
            if (row && row.id) {
                this.log.info('planned > ' + hash + ' > already published');
                continue;
            }
            const response = await reportFunc(outageBody);
            await this.db.insert('ena_message', { hash: hash, body: outageBody, telegram_msg_id: response.message_id });
            this.log.info('planned > ' + hash + ' > published');
        }
    }

    async #reportEmergencies(reportFunc) {
        const emergencies = await this.db.fetchAll('select * from ena_emergency where started_telegram_msg_id is null and started_time >= now() - \'1 day\'::interval and finished_time is null order by started_time, title');
        if (!emergencies || !emergencies.length) {
            this.log.info('no new emergencies');
            return;
        }
        let lines = [ ];
        for (let emergency of emergencies) {
            let line = { string: '', strike: !!emergency.finished_time };
            line.string += moment(emergency.started_time).format('HH:mm');
            if (emergency.finished_time) line.string += '..' + moment(emergency.finished_time).format('HH:mm');
            line.string += ' ' + emergency['title'];
            lines.push(line);
        }
        let lines2 = { };
        for (let line of lines) {
            let match;
            if (match = line.string.match(/^(\d{2}:\d{2}(..\d{2}:\d{2}|) [а-я]\.[А-я ().]+, .+ (ул\.|шоссе|кварт\.|просп\.|проезд|массив|туп\.|трасса|п|пог|шарк|КОМБИНАТ))( (.{1,6})|)$/)) {
                if (!lines2[match[1]]) {
                    lines2[match[1]] = { prefix: match[1], objects: [ ], strike: !!match[2] }
                }
                if (match[4]) {
                    lines2[match[1]]['objects'].push(match[5]);
                }
            } else if (match = line.string.match(/^(\d{2}:\d{2}(..\d{2}:\d{2}|) [а-я]\.[А-я ().]+, .+) ([0-9թաղ./Ա,Բ]{1,5})$/)) {
                if (!lines2[match[1]]) {
                    lines2[match[1]] = { prefix: match[1], objects: [ ], strike: !!match[2] }
                }
                lines2[match[1]]['objects'].push(match[3]);
            } else if (match = line.string.match(/^(\d{2}:\d{2}(..\d{2}:\d{2}|) [^,]+), (.{1,5})$/)) {
                if (!lines2[match[1]]) {
                    lines2[match[1]] = { prefix: match[1], objects: [ ], strike: !!match[2] }
                }
                lines2[match[1]]['objects'].push(match[3]);
            } else {
                if (!lines2[line.string]) {
                    lines2[line.string] = { prefix: line.string, objects: [ ], strike: line.strike };
                }
            }
        }
        let lines3 = [ ];
        for (let line2 of Object.values(lines2)) {
            line2.objects.sort(natsort());
            let lineString = line2.prefix;
            if (line2.objects.length > 5) {
                lineString += ': <i>' + line2.objects.length + ' ' + pluralize(line2.objects.length, '', 'дом', 'дома', 'домов') + '</i>';
            } else if (line2.objects.length > 0) {
                lineString += ': ' + line2.objects.join(', ');
            }
            if (!line2.strike) {
                lines3.push(lineString);
            } else {
                lines3.push('<s>' + lineString + '</s>');
            }
        }
        let report = "Аварийные отключения электричества <b>" + moment().format('DD.MM.YYYY') + "</b>\n\n" + lines3.join("\n");
        const hash = getSHA256ofJSON(report);
        try {
            const response = await reportFunc(report);
            await this.db.insert('ena_message', { hash: hash, body: report, message_group: this.today, telegram_msg_id: response.message_id });
            for (let emergency of emergencies) {
                if (!emergency['started_telegram_msg_id']) {
                    await this.db.update('ena_emergency', { started_telegram_msg_id: response.message_id }, { id: emergency.id });
                }
                if (!emergency['finished_telegram_msg_id'] && emergency['finished_time']) {
                    await this.db.update('ena_emergency', { finished_telegram_msg_id: response.message_id }, { id: emergency.id });
                }
            }
            this.log.info('emergencies published');
        } catch (e) {
            this.log.error(e);
        }
    }
}

module.exports = EnaParser;
