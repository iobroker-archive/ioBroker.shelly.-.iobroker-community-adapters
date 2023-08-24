'use strict';

const shellyHelperGen2 = require('../gen2-helper');

/**
 * Shelly Plus 1 PM / shellyplus1pm
 *
 * https://shelly-api-docs.shelly.cloud/gen2/Devices/ShellyPlus1PM
 */
const shellyplus1pm = {
    'ext.temperature100': {
        mqtt: {
            http_publish: `/rpc/Temperature.GetStatus?id=100`,
            http_publish_funct: value => value ? JSON.parse(value)?.tC : undefined,
        },
        common: {
            name: {
                'en': 'External Temperature',
                'de': 'Außentemperatur',
                'ru': 'Внешняя температура',
                'pt': 'Temperatura externa',
                'nl': 'Externe temperatuur',
                'fr': 'Température externe',
                'it': 'Temperatura esterna',
                'es': 'Temperatura externa',
                'pl': 'Temperatura zewnętrzne',
                'uk': 'Зовнішня температура',
                'zh-cn': '外部经验',
            },
            type: 'number',
            role: 'value.temperature',
            read: true,
            write: false,
            unit: '°C',
        },
    },
};

shellyHelperGen2.addSwitchToGen2Device(shellyplus1pm, 0, true);

shellyHelperGen2.addInputToGen2Device(shellyplus1pm, 0);

module.exports = {
    shellyplus1pm,
};
