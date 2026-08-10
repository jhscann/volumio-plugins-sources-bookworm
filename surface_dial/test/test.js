'use strict';
const assert=require('assert'); const {SurfaceDial}=require('../lib/surface-dial'); const {parseDevices}=require('../lib/bluetooth');
assert.deepStrictEqual(SurfaceDial.parseReport(Buffer.from([1,0,1,0])),{pressed:false,rotation:1});
assert.deepStrictEqual(SurfaceDial.parseReport(Buffer.from([1,1,0xff,0])),{pressed:true,rotation:-1});
assert.deepStrictEqual(SurfaceDial.parseReport(Buffer.from([1,1,0,0])),{pressed:true,rotation:0});
assert.strictEqual(SurfaceDial.parseReport(Buffer.from([2,0,1])),null);
const devices=parseDevices('Device AA:BB:CC:DD:EE:FF Surface Dial\nDevice 11:22:33:44:55:66 Keyboard\n');
assert.strictEqual(devices.length,2); assert.strictEqual(devices[0].name,'Surface Dial'); console.log('All tests passed');
