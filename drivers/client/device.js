'use strict';

const Homey = require('homey');

module.exports = class ClientDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Client device has been initialized');
    const wireless = this.getData().wireless;
    if (wireless !== undefined) {
      this.setStoreValue('wireless', wireless);
    }
    if (this.getStoreValue('wireless') === undefined) {
      this.setStoreValue('wireless', true);
    }
    if (this.hasCapability('measure_signal_strength')) {
      if (this.getStoreValue('wireless') === false) {
        this.log('Adding missing capability: measure_signal_strength');
        await this.removeCapability('measure_signal_strength');
      }
    } else {
      if (this.getStoreValue('wireless') === true) {
        this.log('Adding missing capability: measure_signal_strength');
        await this.addCapability('measure_signal_strength');
      }
    }
    if (!this.hasCapability('reconnect')) {
      this.log('Adding missing capability: reconnect');
      await this.addCapability('reconnect');
    }
    if (!this.hasCapability('block')) {
      this.log('Adding missing capability: block');
      await this.addCapability('block');
    }
    this._wireless = this.getStoreValue('wireless');
    if (this.hasCapability('reconnect') && this._wireless === false) {
      await this.removeCapability('reconnect');
    }
    if (this.hasCapability('reconnect')) {
      this.registerCapabilityListener('reconnect', async (value) => {
        this.log('Reconnect capability triggered, requesting client data refresh');
        await this.homey.app.reconnectClient(this);
      });
    }
    this.registerCapabilityListener('block', async (value) => {
      this.log('Block capability triggered, requesting client block/unblock');
      const siteId = this.getData().siteId;
      const mac = this.getData().mac;
      try {
        await this.homey.app.toggleBlockClient(siteId, mac, value);
        this.log(`Client ${mac} has been ${value ? 'blocked' : 'unblocked'}`);
      } catch (err) {
        this.error(`Failed to ${value ? 'block' : 'unblock'} client ${mac}:`, err.message);
      }
    });
    this.homey.app.registerDevice(this.getData().mac, this);
  }

  getSiteId() {
    return this.getData().siteId;
  }

  // Called by app.js on every poll cycle
  onClientData(client) {
    const connected = client !== null;
    this.setCapabilityValue('alarm_disconnected', !connected).catch(this.error);
    if (connected) this.setCapabilityValue('block', false);

    if (connected && client.ip) {
      this.setCapabilityValue('ip_address', client.ip).catch(this.error);
    }

    if (connected && client.rssi && client.wireless) {
      this.setCapabilityValue('measure_signal_strength', client.rssi).catch(this.error);
    }
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('MyDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('MyDevice settings where changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('MyDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('MyDevice has been deleted');
    this.homey.app.unregisterDevice(this.getData().mac);
  }

};
