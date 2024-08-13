import * as utils from '@iobroker/adapter-core';

import { probe } from '@network-utils/tcp-ping';
import { EventEmitter } from 'events';

class Shelly extends utils.Adapter {
    private isUnloaded: boolean;
    private serverMqtt: null;
    private serverCoap: null;
    private firmwareUpdateTimeout: ioBroker.Timeout | null;
    private onlineCheckTimeout: ioBroker.Timeout | null;
    private onlineDevices: { [key: string]: boolean };
    private eventEmitter: EventEmitter;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'shelly',
        });

        this.isUnloaded = false;

        this.serverMqtt = null;
        this.serverCoap = null;
        this.firmwareUpdateTimeout = null;
        this.onlineCheckTimeout = null;

        this.onlineDevices = {};

        this.eventEmitter = new EventEmitter();

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        try {
            // Upgrade older config
            if (await this.migrateConfig()) {
                return;
            }

            await this.mkdirAsync(this.namespace, 'scripts');

            this.subscribeStates('*');
            // objectHelper.init(this);

            const protocol = this.config.protocol || 'mqtt';

            await this.setOnlineFalse();

            // Start online check
            await this.onlineCheck();

            // Start MQTT server
            setImmediate(() => {
                if (protocol === 'both' || protocol === 'mqtt') {
                    this.log.info(`Starting in MQTT mode. Listening on ${this.config.bind}:${this.config.port} (QoS ${this.config.qos})`);

                    if (!this.config.mqttusername || this.config.mqttusername.length === 0) {
                        this.log.error('MQTT Username is missing!');
                    }
                    if (!this.config.mqttpassword || this.config.mqttpassword.length === 0) {
                        this.log.error('MQTT Password is missing!');
                    }

                    this.serverMqtt = new protocolMqtt.MQTTServer(this, objectHelper, this.eventEmitter);
                    this.serverMqtt.listen();
                }
            });

            // Start CoAP server
            setImmediate(() => {
                if (protocol === 'both' || protocol === 'coap') {
                    this.log.info(`Starting in CoAP mode. Listening on ${this.config.coapbind}:5683`);
                    this.serverCoap = new protocolCoap.CoAPServer(this, objectHelper, this.eventEmitter);
                    this.serverCoap.listen();
                }
            });

            if (this.config.autoupdate) {
                this.log.info(`[firmwareUpdate] Auto-Update enabled - devices will be updated automatically`);

                // Wait 10 seconds for devices to connect
                this.setTimeout(() => this.autoFirmwareUpdate(), 10 * 1000);
            }
        } catch (err) {
            this.log.error(`[onReady] Startup error: ${err}`);
        }
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        // Warning, state can be null if it was deleted
        if (state && !state.ack) {
            const stateId = id.replace(`${this.namespace}.`, '');

            if (stateId === 'info.update') {
                this.log.debug(`[onStateChange] "info.update" state changed - starting update on every device`);

                this.eventEmitter.emit('onFirmwareUpdate');
            } else if (stateId === 'info.downloadScripts') {
                this.log.debug(`[onStateChange] "info.downloadScripts" state changed - starting script download of every device`);

                this.eventEmitter.emit('onScriptDownload');
            } else {
                this.log.debug(`[onStateChange] "${id}" state changed: ${JSON.stringify(state)} - forwarding to objectHelper`);

                if (objectHelper) {
                    objectHelper.handleStateChange(id, state);
                }
            }
        }
    }

    private onUnload(callback: () => void): void {
        this.isUnloaded = true;

        if (this.onlineCheckTimeout) {
            this.clearTimeout(this.onlineCheckTimeout);
            this.onlineCheckTimeout = null;
        }

        this.setOnlineFalse();

        if (this.firmwareUpdateTimeout) {
            this.clearTimeout(this.firmwareUpdateTimeout);
            this.firmwareUpdateTimeout = null;
        }

        try {
            this.log.debug('[onUnload] Closing adapter');

            if (this.serverCoap) {
                try {
                    this.log.debug(`[onUnload] Stopping CoAP server`);
                    this.serverCoap.destroy();
                } catch (err) {
                    // ignore
                }
            }

            if (this.serverMqtt) {
                try {
                    this.log.debug(`[onUnload] Stopping MQTT server`);
                    this.serverMqtt.destroy();
                } catch (err) {
                    // ignore
                }
            }

            callback();
        } catch (e) {
            // this.log.error('Error');
            callback();
        }
    }

    /**
     * Online-Check via TCP ping (when using CoAP)
     */
    async onlineCheck(): Promise<void> {
        const valPort = 80;

        if (this.onlineCheckTimeout) {
            this.clearTimeout(this.onlineCheckTimeout);
            this.onlineCheckTimeout = null;
        }

        try {
            const deviceIds = await this.getAllDeviceIds();
            for (const d in deviceIds) {
                const deviceId = deviceIds[d];

                const idHostname = `${deviceId}.hostname`;

                const stateHostaname = await this.getStateAsync(idHostname);
                const valHostname = stateHostaname ? stateHostaname.val : undefined;

                if (valHostname) {
                    this.log.debug(`[onlineCheck] Checking ${deviceId} on ${valHostname}:${valPort}`);

                    try {
                        const isAlive = await probe(valPort, valHostname);
                        this.deviceStatusUpdate(deviceId, isAlive);
                    } catch (err) {
                        this.log.warn(`[onlineCheck] Failed for ${deviceId} on ${valHostname}:${valPort}: ${err}`);
                    }
                }
            }
        } catch (e) {
            this.log.error(e.toString());
        }

        this.onlineCheckTimeout = this.setTimeout(() => {
            this.onlineCheckTimeout = null;
            this.onlineCheck();
        }, 60 * 1000); // Restart online check in 60 seconds
    }

    async deviceStatusUpdate(deviceId: string, status: boolean): Promise<void> {
        if (this.isUnloaded) return;
        if (!deviceId) return;

        this.log.debug(`[deviceStatusUpdate] ${deviceId}: ${status}`);

        // Check if device object exists
        const knownDeviceIds = await this.getAllDeviceIds();
        if (knownDeviceIds.indexOf(deviceId) === -1) {
            this.log.silly(`[deviceStatusUpdate] ${deviceId} is not in list of known devices: ${JSON.stringify(knownDeviceIds)}`);
            return;
        }

        // Update online status
        const idOnline = `${deviceId}.online`;
        const onlineState = await this.getStateAsync(idOnline);

        if (onlineState) {
            // Compare to previous value
            const prevValue = onlineState.val ? onlineState.val === 'true' || onlineState.val === true : false;

            if (prevValue != status) {
                await this.setStateAsync(idOnline, { val: status, ack: true });
            }
        }

        // Update connection state
        const oldOnlineDeviceCount = Object.keys(this.onlineDevices).length;

        if (status) {
            this.onlineDevices[deviceId] = true;
        } else if (Object.prototype.hasOwnProperty.call(this.onlineDevices, deviceId)) {
            delete this.onlineDevices[deviceId];
        }

        const newOnlineDeviceCount = Object.keys(this.onlineDevices).length;

        // Check online devices
        if (oldOnlineDeviceCount !== newOnlineDeviceCount) {
            this.log.debug(`[deviceStatusUpdate] Online devices: ${JSON.stringify(Object.keys(this.onlineDevices))}`);
            if (newOnlineDeviceCount > 0) {
                await this.setStateAsync('info.connection', { val: true, ack: true });
            } else {
                await this.setStateAsync('info.connection', { val: false, ack: true });
            }
        }
    }

    isOnline(deviceId: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.onlineDevices, deviceId);
    }

    async getAllDeviceIds(): Promise<string[]> {
        const devices = await this.getDevicesAsync();
        return devices.map((device) => this.removeNamespace(device._id));
    }

    async setOnlineFalse(): Promise<void> {
        const deviceIds = await this.getAllDeviceIds();
        for (const d in deviceIds) {
            const deviceId = deviceIds[d];
            const idOnline = `${deviceId}.online`;
            const onlineState = await this.getStateAsync(idOnline);

            if (onlineState) {
                await this.setStateAsync(idOnline, { val: false, ack: true });
            }

            await this.extendObjectAsync(deviceId, {
                common: {
                    color: null, // Remove color from previous versions
                },
            });
        }

        this.onlineDevices = {};
        await this.setStateAsync('info.connection', { val: false, ack: true });
    }

    autoFirmwareUpdate(): void {
        if (this.isUnloaded) return;
        if (this.config.autoupdate) {
            this.log.debug(`[firmwareUpdate] Starting update on every device`);

            this.eventEmitter.emit('onFirmwareUpdate');

            this.firmwareUpdateTimeout = this.setTimeout(
                () => {
                    this.firmwareUpdateTimeout = null;
                    this.autoFirmwareUpdate();
                },
                15 * 60 * 1000,
            ); // Restart firmware update in 60 Seconds
        }
    }

    async processBleMessage(val) {
        // TODO: Just set values once when called by multiple devices
        if (val && val.scriptVersion && val.src && val.payload) {
            if (val.scriptVersion !== '0.1') {
                this.log.warn(`[BLE] ${val.srcBle.mac} (via ${val.src}): BLE-Script version is invalid, check documentation for latest version`);
            }

            const typesList = {
                rssi: { type: 'number', unit: 'dBm' },
                battery: { type: 'number', unit: '%' },
                temperature: { type: 'number', unit: '°C' },
                humidity: { type: 'number', unit: '%' },
                illuminance: { type: 'number' },
                motion: { type: 'number' },
                window: { type: 'number' },
                button: { type: 'number' },
                rotation: { type: 'number' },
            };

            await this.extendObjectAsync(
                `ble.${val.srcBle.mac}`,
                {
                    type: 'device',
                    common: {
                        name: val.srcBle.mac,
                        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMjAgNTEyIj48IS0tISBGb250IEF3ZXNvbWUgUHJvIDYuNC4yIGJ5IEBmb250YXdlc29tZSAtIGh0dHBzOi8vZm9udGF3ZXNvbWUuY29tIExpY2Vuc2UgLSBodHRwczovL2ZvbnRhd2Vzb21lLmNvbS9saWNlbnNlIChDb21tZXJjaWFsIExpY2Vuc2UpIENvcHlyaWdodCAyMDIzIEZvbnRpY29ucywgSW5jLiAtLT48cGF0aCBkPSJNMTk2LjQ4IDI2MC4wMjNsOTIuNjI2LTEwMy4zMzNMMTQzLjEyNSAwdjIwNi4zM2wtODYuMTExLTg2LjExMS0zMS40MDYgMzEuNDA1IDEwOC4wNjEgMTA4LjM5OUwyNS42MDggMzY4LjQyMmwzMS40MDYgMzEuNDA1IDg2LjExMS04Ni4xMTFMMTQ1Ljg0IDUxMmwxNDguNTUyLTE0OC42NDQtOTcuOTEyLTEwMy4zMzN6bTQwLjg2LTEwMi45OTZsLTQ5Ljk3NyA0OS45NzgtLjMzOC0xMDAuMjk1IDUwLjMxNSA1MC4zMTd6TTE4Ny4zNjMgMzEzLjA0bDQ5Ljk3NyA0OS45NzgtNTAuMzE1IDUwLjMxNi4zMzgtMTAwLjI5NHoiLz48L3N2Zz4=',
                    },
                    native: {},
                },
                { preserve: { common: ['name'] } },
            );

            for (const [key, value] of Object.entries(val.payload)) {
                if (Object.keys(typesList).includes(key)) {
                    await this.extendObjectAsync(`ble.${val.srcBle.mac}.${key}`, {
                        type: 'state',
                        common: {
                            name: key,
                            type: typesList[key].type,
                            role: 'value',
                            read: true,
                            write: false,
                            unit: typesList[key]?.unit,
                        },
                        native: {},
                    });

                    await this.setStateAsync(`ble.${val.srcBle.mac}.${key}`, { val: value, ack: true, c: val.src });
                }
            }
        }
    }

    removeNamespace(id) {
        const re = new RegExp(`${this.namespace}*\\.`, 'g');
        return id.replace(re, '');
    }

    async migrateConfig() {
        const native = {};
        if (this.config?.http_username) {
            native.httpusername = this.config.http_username;
            native.http_username = '';
        }
        if (this.config?.http_password) {
            native.httppassword = this.config.http_password;
            native.http_password = '';
        }
        if (this.config?.user) {
            native.mqttusername = this.config.user;
            native.user = '';
        }
        if (this.config?.password) {
            native.mqttpassword = this.config.password;
            native.password = '';
        }
        if (this.config?.keys) {
            native.blacklist = this.config.keys.map((b) => {
                return { id: b.blacklist };
            });
            native.keys = null;
        }

        if (this.config) {
            this.config.polltime = parseInt(this.config?.polltime, 10);
        }

        if (Object.keys(native).length) {
            this.log.info('Migrate some data from old Shelly Adapter version. Restarting Shelly Adapter now!');
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native });

            return true;
        }

        return false;
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Shelly(options);
} else {
    // otherwise start the instance directly
    (() => new Shelly())();
}
