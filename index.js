/* eslint-disable no-invalid-this,consistent-this,max-lines-per-function */
/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2016 @biddster
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
'use strict';
module.exports = function(RED) {
    const moment = require('moment');
    const SunCalc = require('suncalc');
    const _ = require('lodash');
    const fmt = 'YYYY-MM-DD HH:mm';

    const Status = Object.freeze({
        SCHEDULED: Symbol('scheduled'),
        SUSPENDED: Symbol('suspended'),
        FIRED: Symbol('fired'),
        ERROR: Symbol('error')
    });

    RED.nodes.registerType('schedex', function(config) {
        RED.nodes.createNode(this, config);
        const node = this,
            events = { on: setupEvent('on', 'dot'), off: setupEvent('off', 'ring') };

        function inverse(event) {
            return event === events.on ? events.off : events.on;
        }

        // migration code : if new values are undefined, set all to true
        if (
            config.sun === undefined &&
            config.mon === undefined &&
            config.tue === undefined &&
            config.wed === undefined &&
            config.thu === undefined &&
            config.fri === undefined &&
            config.sat === undefined
        ) {
            const name = config.name || `${config.ontime} - ${config.offtime}`;
            node.warn(
                `Schedex [${name}]: New weekday configuration attributes are not defined, please edit the node. Defaulting to true.`
            );
            config.sun = config.mon = config.tue = config.wed = config.thu = config.fri = config.sat = true;
        }

        const weekdays = Object.freeze([
            config.mon,
            config.tue,
            config.wed,
            config.thu,
            config.fri,
            config.sat,
            config.sun
        ]);

        node.on('input', function(msg) {
            let handled = false,
                requiresBootstrap = false;
            if (_.isString(msg.payload)) {
                // TODO - with these payload options, we can't support on and ontime etc.
                if (msg.payload === 'on') {
                    handled = true;
                    send(events.on, true);
                } else if (msg.payload === 'off') {
                    handled = true;
                    send(events.off, true);
                } else if (msg.payload === 'info') {
                    handled = true;
                    node.send({
                        topic: 'info',
                        payload: {
                            on: isSuspended()
                                ? 'suspended'
                                : events.on.moment.toDate().toUTCString(),
                            off: isSuspended()
                                ? 'suspended'
                                : events.off.moment.toDate().toUTCString(),
                            state: isSuspended()
                                ? 'suspended'
                                : events.off.moment.isAfter(events.on.moment)
                                    ? 'off'
                                    : 'on',
                            ontopic: events.on.topic,
                            onpayload: events.on.payload,
                            offtopic: events.off.topic,
                            offpayload: events.off.payload
                        }
                    });
                } else {
                    enumerateProgrammables(function(obj, prop, payloadName, typeConverter) {
                        const match = new RegExp(`.*${payloadName}\\s+(\\S+)`, 'u').exec(
                            msg.payload
                        );
                        if (match) {
                            handled = true;
                            const previous = obj[prop];
                            obj[prop] = typeConverter(match[1]);
                            requiresBootstrap = requiresBootstrap || previous !== obj[prop];
                        }
                    });
                }
            } else {
                enumerateProgrammables(function(obj, prop, payloadName, typeConverter) {
                    if (msg.payload.hasOwnProperty(payloadName)) {
                        handled = true;
                        const previous = obj[prop];
                        obj[prop] = typeConverter(msg.payload[payloadName]);
                        requiresBootstrap = requiresBootstrap || previous !== obj[prop];
                    }
                });
            }
            if (!handled) {
                setStatus(Status.ERROR, { error: 'Unsupported input' });
            } else if (requiresBootstrap) {
                bootstrap();
            }
        });

        node.on('close', suspend);

        function setupEvent(eventName, shape) {
            const filtered = _.pickBy(config, function(value, key) {
                return key && key.indexOf(eventName) === 0;
            });
            const event = _.mapKeys(filtered, function(value, key) {
                return key.substring(eventName.length).toLowerCase();
            });
            event.name = eventName.toUpperCase();
            event.shape = shape;
            event.callback = function() {
                send(event);
                schedule(event);
            };
            return event;
        }

        function send(event, manual) {
            node.send({ topic: event.topic, payload: event.payload });
            setStatus(Status.FIRED, { event, manual });
        }

        function schedule(event, isInitial) {
            if (!event.time) {
                return true;
            }
            const now = node.now();
            const matches = new RegExp('(\\d+):(\\d+)', 'u').exec(event.time);
            if (matches && matches.length) {
                // Don't use existing 'now' moment here as hour and minute mutate the moment.
                event.moment = node
                    .now()
                    .hour(+matches[1])
                    .minute(+matches[2]);
            } else {
                const sunCalcTimes = SunCalc.getTimes(new Date(), config.lat, config.lon);
                const date = sunCalcTimes[event.time];
                if (date) {
                    event.moment = moment(date);
                }
            }
            if (!event.moment) {
                setStatus(Status.ERROR, { error: `Invalid time [${event.time}]` });
                return false;
            }
            event.moment.seconds(0);

            if (event.offset) {
                let adjustment = event.offset;
                if (event.randomoffset) {
                    adjustment = event.offset * Math.random();
                }
                event.moment.add(adjustment, 'minutes');
            }

            if (!isInitial || (isInitial && now.isAfter(event.moment))) {
                event.moment.add(1, 'day');
            }

            // Adjust weekday if not selected
            while (!weekdays[event.moment.isoWeekday() - 1]) {
                event.moment.add(1, 'day');
            }

            if (event.timeout) {
                clearTimeout(event.timeout);
            }
            const delay = event.moment.diff(now);
            event.timeout = setTimeout(event.callback, delay);
            return true;
        }

        function suspend() {
            clearTimeout(events.on.timeout);
            events.on.moment = null;
            clearTimeout(events.off.timeout);
            events.off.moment = null;
            setStatus(Status.SUSPENDED);
        }

        function resume() {
            if (schedule(events.on, true) && schedule(events.off, true)) {
                setStatus(Status.SCHEDULED);
            }
        }

        function setStatus(status, { event = null, manual = false, error = null } = {}) {
            const message = [];
            let shape = 'dot',
                fill = 'red';
            if (status === Status.SCHEDULED) {
                fill = 'yellow';
                if (events.on.moment && events.off.moment) {
                    const firstEvent = events.on.moment.isBefore(events.off.moment)
                        ? events.on
                        : events.off;
                    message.push(firstEvent.name);
                    message.push(firstEvent.moment.format(fmt));
                    message.push(inverse(firstEvent).name);
                    message.push(inverse(firstEvent).moment.format(fmt));
                } else if (events.on.moment) {
                    message.push(events.on.name);
                    message.push(events.on.moment.format(fmt));
                } else if (events.off.moment) {
                    message.push(events.off.name);
                    message.push(events.off.moment.format(fmt));
                }
            } else if (status === Status.FIRED) {
                // eslint-disable-next-line prefer-destructuring
                shape = event.shape;
                fill = manual ? 'blue' : 'green';
                message.push(event.name);
                message.push(manual ? 'manual' : 'auto');
                if (isSuspended()) {
                    message.push('- scheduling suspended');
                } else {
                    message.push(`until ${inverse(event).moment.format(fmt)}`);
                }
            } else if (status === Status.SUSPENDED) {
                fill = 'grey';
                message.push('Scheduling suspended');
                if (weekdays.indexOf(true) === -1) {
                    message.push('(no weekdays selected)');
                } else if (!events.on.time && !events.off.time) {
                    message.push('(no on or off time)');
                }
                message.push('- manual mode only');
            } else if (status === Status.ERROR) {
                message.push(error);
            }

            node.status({ fill, shape, text: message.join(' ') });
        }

        function bootstrap() {
            if (isSuspended()) {
                suspend();
            } else {
                resume();
            }
        }

        function isSuspended() {
            return (
                config.suspended ||
                weekdays.indexOf(true) === -1 ||
                (!events.on.time && !events.off.time)
            );
        }

        function enumerateProgrammables(callback) {
            callback(events.on, 'time', 'ontime', String);
            callback(events.on, 'topic', 'ontopic', String);
            callback(events.on, 'payload', 'onpayload', String);
            callback(events.on, 'offset', 'onoffset', Number);
            callback(events.on, 'randomoffset', 'onrandomoffset', toBoolean);
            callback(events.off, 'time', 'offtime', String);
            callback(events.off, 'topic', 'offtopic', String);
            callback(events.off, 'payload', 'offpayload', String);
            callback(events.off, 'offset', 'offoffset', Number);
            callback(events.off, 'randomoffset', 'offrandomoffset', toBoolean);
            callback(config, 'mon', 'mon', toBoolean);
            callback(config, 'tue', 'tue', toBoolean);
            callback(config, 'wed', 'wed', toBoolean);
            callback(config, 'thu', 'thu', toBoolean);
            callback(config, 'fri', 'fri', toBoolean);
            callback(config, 'sat', 'sat', toBoolean);
            callback(config, 'sun', 'sun', toBoolean);
            callback(config, 'lon', 'lon', Number);
            callback(config, 'lat', 'lat', Number);
            callback(config, 'suspended', 'suspended', toBoolean);
        }

        function toBoolean(val) {
            // eslint-disable-next-line prefer-template
            return (val + '').toLowerCase() === 'true';
        }

        // Bodges to allow testing
        node.schedexEvents = () => events;
        node.schedexConfig = () => config;
        node.now = moment;

        bootstrap();
    });
};
