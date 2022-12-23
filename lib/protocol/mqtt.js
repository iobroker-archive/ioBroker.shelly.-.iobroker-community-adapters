'use strict';

const BaseClient = require(__dirname + '/base').BaseClient;
const BaseServer = require(__dirname + '/base').BaseServer;
const datapoints = require(__dirname + '/../datapoints');

const Aedes = require('aedes');
const net = require('net');

const INIT_SRC = 'iobroker-init';

/**
 * checks if  funcito is an asynchron function
 * @param {function} funct - function
 */
function isAsync(funct) {
    if (funct && funct.constructor) return funct.constructor.name == 'AsyncFunction';
    return undefined;
}

class MQTTClient extends BaseClient {
    constructor(adapter, objectHelper, eventEmitter, client) {

        super('mqtt', adapter, objectHelper, eventEmitter);

        this.client = client;
        this.stream = client.conn;

        this.id = client.id;

        this.mqttprefix;
        this.will = undefined;

        this.start();
    }

    /**
     * @inheritdoc
     */
    getSerialId() {
        if (!this.serialId) {
            let id = this.getId();
            if (id) {
                id = id.replace(/(.+?)\/(.+?)\/(.*)/, '$2');
                this.serialId = id.replace(/(.+)-(.+)/, '$2');
            }
        }
        return this.serialId;
    }

    /**
     * @inheritdoc
     */
    getDeviceClass() {
        if (!this.deviceClass) {
            let id = this.getId();
            if (id) {
                id = id.replace(/(.+?)\/(.+?)\/(.*)/, '$2');
                this.deviceClass = id.replace(/(.+)-(.+)/, '$1');
            }
        }
        return this.deviceClass;
    }

    /**
     * @inheritdoc
     */
    getDeviceType() {
        if (!this.deviceType) {
            const deviceClass = this.getDeviceClass();
            this.deviceType = datapoints.getDeviceTypeByClass(deviceClass);
        }
        return this.deviceType;
    }

    /**
     * @inheritdoc
     */
    getDeviceId() {
        if (!this.deviceId) {
            const deviceType = this.getDeviceType();
            const serialId = this.getSerialId();
            if (deviceType && serialId) {
                this.deviceId = deviceType + '#' + serialId + '#1';
            }
        }
        return this.deviceId;
    }

    getMqttPrefix() {
        return this.mqttprefix;
    }

    replacePrefixIn(topic) {
        return new String(topic).replace(new RegExp('<mqttprefix>', 'g'), this.getMqttPrefix());
    }

    destroy() {
        super.destroy();
        this.adapter.log.debug(`[MQTT] Destroying`);

        this.mqttprefix = undefined;
        this.will = undefined;
    }

    /**
     * @inheritdoc
     */
    publishStateValue(topic, value) {
        if (topic.indexOf('<mqttprefix>') > 0 && !this.getMqttPrefix()) {
            this.adapter.log.warn(`[MQTT] Unable to publish message to ${this.getLogInfo()} - mqtt prefix was not set but is required for this message: ${topic} = ${value}`);
            return;
        }

        topic = this.replacePrefixIn(topic);

        const qos = parseInt(this.adapter.config.qos) ?? 0;
        const msgId = this.getNextMsgId();

        try {
            this.adapter.log.debug(`[MQTT] Send state to ${this.getLogInfo()} with QoS ${qos}: ${topic} = ${value} (${msgId})`);
            this.client.publish({ topic: topic, payload: value, qos: qos, messageId: msgId }, () => {});
        } catch (err) {
            this.adapter.log.debug(`[MQTT] Unable to publish message to ${this.getLogInfo()} - received error "${err}": ${topic} = ${value}`);
        }
    }

    /**
     * State changes from device will be saved in the ioBroker states
     * @param {object} payload - object can be ervery type of value
     */
    async createIoBrokerState(topic, payload) {
        this.adapter.log.silly(`[MQTT] Message for ${this.getLogInfo()}: ${topic} / ${JSON.stringify(payload)} (${payload.toString()})`);

        const dps = this.getAllTypePublishStates();
        for (const i in dps) {
            const dp = dps[i];
            const deviceId = this.getDeviceId();
            const fullStateId = `${deviceId}.${dp.state}`;
            let value = payload.toString();

            this.adapter.log.silly(`[MQTT] Message with value for ${this.getLogInfo()}: ${topic} -> state: ${fullStateId}, value: ${value}`);

            try {
                if (this.replacePrefixIn(dp.mqtt.mqtt_publish) === topic) {
                    if (dp.mqtt?.mqtt_publish_funct) {
                        value = isAsync(dp.mqtt.mqtt_publish_funct) ? await dp.mqtt.mqtt_publish_funct(value, this) : dp.mqtt.mqtt_publish_funct(value, this);
                    }

                    if (dp.common.type === 'boolean' && value === 'false') value = false;
                    if (dp.common.type === 'boolean' && value === 'true') value = true;
                    if (dp.common.type === 'number' && value !== undefined) value = Number(value);

                    if (Object.prototype.hasOwnProperty.call(this.device, dp.state)) {
                        if (value !== undefined && (!Object.prototype.hasOwnProperty.call(this.stateValueCache, fullStateId) || this.stateValueCache[fullStateId] !== value || this.adapter.config.updateUnchangedObjects)) {
                            this.adapter.log.debug(`[MQTT] State change ${this.getLogInfo()}: ${topic} -> state: ${fullStateId}, value: ${JSON.stringify(value)}`);
                            this.stateValueCache[fullStateId] = value;
                            this.objectHelper.setOrUpdateObject(fullStateId, {
                                type: 'state',
                                common: dp.common,
                            }, ['name'], value);
                        }
                    }
                }
            } catch (err) {
                this.adapter.log.error(`[MQTT] Error ${err} in function dp.mqtt.mqtt_publish_funct of state ${fullStateId} for ${this.getLogInfo()}`);
            }
        }

        this.objectHelper.processObjectQueue(() => { });
    }

    async setMqttPrefixHttp() {
        if (this.mqttprefix) {
            return this.mqttprefix;
        }

        this.adapter.log.debug(`[MQTT] Started mqttprefix fallback via HTTP for ${this.getLogInfo()} (Gen ${this.getDeviceGen()})`);

        if (this.getDeviceGen() == 1) {
            try {
                const body = await this.requestAsync('/settings');
                if (body) {
                    const settings = JSON.parse(body);
                    this.mqttprefix = settings.mqtt.id;

                    this.adapter.log.debug(`[MQTT] Requested mqttprefix for ${this.getLogInfo()} (Gen 1): ${this.mqttprefix}`);

                    return this.mqttprefix;
                }
            } catch (err) {
                if (err && err.response && err.response.status == 401) {
                    this.adapter.log.error(`[MQTT] Wrong http username or http password! Please enter the user credential from restricted login for ${this.getLogInfo()}`);
                } else {
                    this.adapter.log.error(`[MQTT] Error in function setMqttPrefixHttp (Gen 1) for ${this.getLogInfo()}: ${err}`);
                }
            }
        } else if (this.getDeviceGen() == 2) {
            try {
                const body = await this.requestAsync('/rpc/Mqtt.GetConfig');
                if (body) {
                    const settings = JSON.parse(body);
                    this.mqttprefix = settings.topic_prefix;

                    this.adapter.log.debug(`[MQTT] Requested mqttprefix for ${this.getLogInfo()} (Gen 2): ${this.mqttprefix}`);

                    return this.mqttprefix;
                }
            } catch (err) {
                this.adapter.log.error(`[MQTT] Error in function setMqttPrefixHttp (Gen 2) for ${this.getLogInfo()}: ${err}`);
            }
        }

        return undefined;
    }

    setMqttPrefixByWill(topic) {
        // Gen1: "shellies/huhu-shellybutton1-A4CF12F454A3/online"
        // Gen2: "shellyplus1pm-44179394d4d4/online"

        if (this.mqttprefix) {
            return this.mqttprefix;
        } else {
            if (topic) {
                const arr = topic.split('/');
                if (this.getDeviceGen() == 1) {
                    if (arr[0] === 'shellies') {
                        this.mqttprefix = arr[1];
                        this.adapter.log.debug(`[MQTT] setMqttPrefixByWill (Gen 1): ${this.mqttprefix}`);
                        return this.mqttprefix;
                    }
                } else if (this.getDeviceGen() == 2) {
                    this.mqttprefix = arr.slice(0, -1).join('/');
                    this.adapter.log.debug(`[MQTT] setMqttPrefixByWill (Gen 2): ${this.mqttprefix}`);
                    return this.mqttprefix;
                }
            }
            return undefined;
        }
    }

    async start() {
        if (this.deviceExists()) {
            this.adapter.log.info(`[MQTT] Device with client id "${this.getId()}" connected!`);

            // Device Mode information (init)
            await this.initDeviceModeFromState();

            await this.deleteOldStates();
            await this.createObjects();

            // Save last will
            // Gen 1: {"retain": false, "qos": 0, "topic" :"shellies/shellyswitch25-C45BBE798F0F/online", "payload": {"type":"Buffer","data": [102,97,108,115,101]}}
            // Gen 2: {"retain": false, "qos": 0, "topic": "shellypro2pm-30c6f7850a64/online", "payload": {"type":"Buffer","data":[102,97,108,115,101]}}
            //if (packet.will) {
            //    this.will = packet.will;
            //    this.adapter.log.debug(`[MQTT] Last will for client id "${this.getId()}" saved: ${JSON.stringify(this.will)}`);
            //}

            const ip = (this.stream && this.stream.remoteAddress) ? this.stream.remoteAddress : null;
            if (ip) {
                await this.setIP(ip, 'MQTT connect');
            } else {
                this.initIPFromState();
            }

            this.adapter.deviceStatusUpdate(this.getDeviceId(), true); // Device online

            this.httpIoBrokerState();

            if (this.will && this.will.topic) {
                this.setMqttPrefixByWill(this.will.topic);
            } else {
                await this.setMqttPrefixHttp();
            }

            if (!this.getMqttPrefix()) {
                this.adapter.log.error(`[MQTT] Unable to get mqttprefix of client with id "${this.getId()}"`);
            }

            try {
                this.client.connack({ returnCode: 0 });

                // Device Mode information (request)
                if (this.getDeviceGen() == 2) {
                    try {
                        // Ask for more information (like IP address)
                        this.publishStateValue(
                            '<mqttprefix>/rpc',
                            JSON.stringify({id: this.getNextMsgId(), src: INIT_SRC, method: 'Shelly.GetDeviceInfo', params: { ident: true }}),
                        );

                        this.publishStateValue(
                            '<mqttprefix>/rpc',
                            JSON.stringify({id: this.getNextMsgId(), src: INIT_SRC, method: 'Shelly.GetStatus' }),
                        );
                    } catch (err) {
                        this.adapter.log.debug(`[MQTT] Client communication error (publish): "${this.getId()}" - error: ${err}`);
                    }
                }
            } catch (err) {
                this.adapter.log.debug(`[MQTT] Client communication error (connack): "${this.getId()}" - error: ${err}`);
            }
        } else {
            //throw new Error('DEVICE_UNKNOWN');
        }

        this.client.on('error', (error) => {
            this.adapter.log.info(`[MQTT] Client Error: ${this.getLogInfo()} (${error})`);
        });
    }

    async publish(packet) {
        if (this.adapter.isUnloaded) return;

        this.adapter.log.silly(`[MQTT] Publish: ${this.getLogInfo()} - ${JSON.stringify(packet)}`);
        if (packet.payload) {
            this.adapter.log.debug(`[MQTT] Publish: ${this.getLogInfo()} - topic: ${packet.topic}, qos: ${packet.qos}, payload: ${packet.payload.toString()}`);

            // Generation 1
            if (this.getDeviceGen() == 1) {
                if (packet.topic === 'shellies/announce') {
                    try {
                        const payloadObj = JSON.parse(packet.payload);

                        // Update IP address
                        const ip = payloadObj?.ip;
                        if (ip && ip !== this.getIP()) {
                            this.setIP(ip, 'Gen 1 shellies/announce');
                            this.adapter.deviceStatusUpdate(this.getDeviceId(), true); // Device online
                        }

                        // Device Mode information (new)
                        const newDeviceMode = payloadObj?.mode;
                        if (newDeviceMode) {
                            await this.setDeviceMode(newDeviceMode);
                        }

                    } catch (err) {
                        // we do not change anything
                    }
                }
            }

            // Generation 2
            if (this.getDeviceGen() == 2) {
                if (packet.topic == 'iobroker/rpc') {
                    try {
                        const payloadObj = JSON.parse(packet.payload.toString());

                        // Error handling for Gen 2 devices
                        if (payloadObj?.error) {
                            this.adapter.log.error(`[MQTT] Received error message for ${this.getLogInfo()} - from "${payloadObj.src}": ${JSON.stringify(payloadObj.error)}`);
                        }

                    } catch (err) {
                        this.adapter.log.debug(`[MQTT] Error parsing command response: ${this.getLogInfo()} - topic: ${packet.topic}, error: ${err}`);
                    }
                }

                if (packet.topic == `${INIT_SRC}/rpc`) {
                    try {
                        const payloadObj = JSON.parse(packet.payload.toString());

                        // Update IP address
                        const ip = payloadObj?.result?.eth?.ip || payloadObj?.result?.wifi?.sta_ip;
                        if (ip && ip !== this.getIP()) {
                            this.setIP(ip, `Gen 2 ${INIT_SRC}/rpc`);
                            this.adapter.deviceStatusUpdate(this.getDeviceId(), true); // Device online
                        }

                        // Device Mode information (new)
                        if (payloadObj?.result?.profile) {
                            const newDeviceMode = payloadObj?.result?.profile;
                            if (newDeviceMode) {
                                await this.setDeviceMode(newDeviceMode);
                            }
                        }

                    } catch (err) {
                        this.adapter.log.debug(`[MQTT] Error parsing init command response: ${this.getLogInfo()} - topic: ${packet.topic}, error: ${err}`);
                    }
                }

                // Log debug messages for Gen 2 devices (if enabled in instance configuration)
                if (packet.topic === `${this.getMqttPrefix()}/debug/log`) {
                    if (this.adapter.config.logDebugMessages) {
                        this.adapter.log.info(`[Shelly Debug Message] ${this.getLogInfo()}: ${packet.payload.toString().trim()}`);
                    }
                }
            }
        }

        this.createIoBrokerState(packet.topic, packet.payload);
    }
}

class MQTTServer extends BaseServer {

    constructor(adapter, objectHelper, eventEmitter) {
        //if (!(this instanceof MQTTServer)) return new MQTTServer(adapter, objectHelper, eventEmitter);

        super(adapter, objectHelper, eventEmitter);

        this.aedes = new Aedes.Server({
            id: `iobroker.${adapter.namespace}`,
            authenticate: (client, username, password, callback) => {
                if (client?.id) {
                    const pass = Buffer.from(password, 'base64').toString();

                    if (username === adapter.config.mqttusername && pass === adapter.config.mqttpassword) {
                        return callback(null, true);
                    }

                    this.adapter.log.error(`[MQTT] Wrong MQTT authentification of client "${client.id}"`);
                    return callback(new Error('Authentication Failed! Please enter valid credentials.'), false);
                }

                return callback(new Error('Client ID is missing'), false);
            },
        });

        this.server = net.createServer(this.aedes.handle);

        this.clients = {};
    }

    listen() {
        this.aedes.on('clientReady', (client) => {
            if (client?.id) {
                this.adapter.log.debug(`CLIENT_CONNECTED : MQTT Client ${(client ? client.id : client)} connected to aedes broker ${this.id}`);

                try {
                    this.clients[client.id] = new MQTTClient(this.adapter, this.objectHelper, this.eventEmitter, client);
                } catch (err) {
                    if (err.message == 'DEVICE_UNKNOWN') {
                        this.adapter.log.error(`[MQTT] (Shelly?) device unknown, configuration for client with id "${this.id}" does not exist!`);
                        this.adapter.log.error(`[MQTT] DO NOT CHANGE THE CLIENT-ID OF YOUR SHELLY DEVICES (see adapter documentation for details)`);
                    }
                }
            }
        });

        this.aedes.on('clientError', (client, error) => {
            this.adapter.log.error(`[MQTT Server] Client error: ${client.id} ${error}`);
        });

        this.aedes.on('connectionError', (client, error) => {
            this.adapter.log.error(`[MQTT Server] Connection error: ${client.id} ${error}`);
        });

        this.aedes.on('keepaliveTimeout', (client) => {
            this.adapter.log.error(`[MQTT Server] Keepalive timeout: ${client.id}`);
        });

        this.aedes.on('publish', (packet, client) => {
            if (client?.id && Object.prototype.hasOwnProperty.call(this.clients, client.id)) {
                this.clients[client.id].publish(packet);
            }
        });

        // emitted when a client disconnects from the broker
        this.aedes.on('clientDisconnect', (client) => {
            this.adapter.log.debug(`CLIENT_DISCONNECTED : MQTT Client ${(client ? client.id : client)} disconnected`);
            if (client?.id && Object.prototype.hasOwnProperty.call(this.clients, client.id)) {
                this.clients[client.id].destroy();
                delete this.clients[client.id];
            }
        });

        this.server.on('close', () => {
            this.adapter.log.debug(`[MQTT Server] Closing`);
        });

        this.server.on('error', (error) => {
            this.adapter.log.debug(`[MQTT Server] Error: ${error}`);
        });

        this.server.listen(this.adapter.config.port, this.adapter.config.bind, () => {
            this.adapter.log.debug(`[MQTT Server] Started listener on ${this.adapter.config.bind}:${this.adapter.config.port}`);
        });
    }

    destroy() {
        super.destroy();
        this.adapter.log.debug(`[MQTT Server] Destroying`);

        for (const i in this.clients) {
            this.clients[i].destroy();
        }
        this.server.close();
    }
}

module.exports = {
    MQTTServer: MQTTServer,
};