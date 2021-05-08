/* HTTP/2 Binary Data Dump */

/* jshint esversion: 6 */
/* jshint node: true */
"use strict";

const fs = require('fs'),
    zlib = require('zlib'),
    HPACK = require('hpack');

const FRAME_TYPES = {
    DATA: 0x0,
    HEADERS: 0x1,
    PRIORITY: 0x2,
    RST_STREAM: 0x3,
    SETTINGS: 0x4,
    PUSH_PROMISE: 0x5,
    PING: 0x6,
    GOAWAY: 0x7,
    WINDOW_UPDATE: 0x8,
    CONTINUATION: 0x9,
    ALTSVC: 0xa,
    ORIGIN: 0xc
};

const SETTINGS_IDS = {
    SETTINGS_HEADER_TABLE_SIZE: 0x1,
    SETTINGS_ENABLE_PUSH: 0x2,
    SETTINGS_MAX_CONCURRENT_STREAMS: 0x3,
    SETTINGS_INITIAL_WINDOW_SIZE: 0x4,
    SETTINGS_MAX_FRAME_SIZE: 0x5,
    SETTINGS_MAX_HEADER_LIST_SIZE: 0x6
};

const DATA_FLAGS = {
    END_STREAM: 0x1,
    PADDED: 0x8
};

function parse_uint32_be(array, pos) {
    return (array[pos] << 24) |
        (array[pos + 1] << 16) |
        (array[pos + 2] << 8) |
        array[pos + 3];
}

function parse_uint24_be(array, pos) {
    return (array[pos] << 16) |
        (array[pos + 1] << 8) |
        array[pos + 2];
}

function parse_uint16_be(array, pos) {
    return (array[pos] << 8) |
        array[pos + 1];
}

function parse_uint8(array, pos) {
    return array[pos];
}

function array_starts(array1, array2) {
    for (let i = 0; i < array2.length; i++) {
        if (array1[i] != array2[i]) {
            return false;
        }
    }
    return true;
}

function parse_preface(array, pos, limit) {
    const preface = Buffer.from('505249202a20485454502f322e300d0a0d0a534d0d0a0d0a', 'hex');
    if (preface.length <= array.length) {
        if (array_starts(array.slice(pos, pos + preface.length), preface)) {
            return preface.length;
        }
    }
    return -1;
}

function extract_frame(array, pos) {
    const frame = {};
    const len = parse_uint24_be(array, pos);
    if (len < 0) {
        throw new Error('Invalid frame length: ' + len);
    }
    pos += 3;
    frame.type = parse_uint8(array, pos);
    pos++;
    frame.flags = parse_uint8(array, pos++);
    frame.sysid = parse_uint32_be(array, pos) & 0x7fffffff;
    pos += 4;
    frame.data = array.slice(pos, pos + len);
    return frame;
}

function extract_frames(array) {
    const frames = [];
    let pos = 0;
    for (let seq = 0; pos + 9 <= array.length; seq++) {
        const ret = parse_preface(array, pos);
        if (ret >= 0) {
            pos += ret;
        } else {
            const frame = extract_frame(array, pos);
            frames.push(frame);
            pos += frame.data.length + 9;
        }
    }
    return frames;
}

function defrag_frames(frames) {
    const defrag = [];
    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        if (frame.type === FRAME_TYPES.CONTINUATION) {
            if (defrag.length === 0) {
                throw new Error('Defragmentation stack is empty');
            }
            const lastidx = defrag.length - 1;
            const last = defrag[lastidx];
            console.log('defrag -> (' + lastidx + '; ' + i + '): ' +
                last.data.length + ' bytes + ' + frame.data.length +
                ' bytes = ' + (last.data.length + frame.data.length) + ' bytes');
            last.data = Buffer.concat([last.data, frame.data]);
        } else {
            defrag.push(frame);
        }
    }
    return defrag;
}

function decompress_frames(frames) {
    let codec = new HPACK();
    const server_codec = new HPACK();
    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        if (frame.type === FRAME_TYPES.GOAWAY) {
            codec = new HPACK();
        } else if (frame.type === FRAME_TYPES.SETTINGS) {
            if (frame.data.length === 6) {
                const id = parse_uint16_be(frame.data, 0);
                const value = parse_uint32_be(frame.data, 2);
                if (id === SETTINGS_IDS.SETTINGS_HEADER_TABLE_SIZE) {
                    console.log('settings -> update table size, new size:' + value);
                    codec.setTableSize(value);
                }
            }
        } else if ([FRAME_TYPES.HEADERS, FRAME_TYPES.PUSH_PROMISE].includes(frame.type)) {
            frame.data = codec.decode(frame.data);
        }
    }
    return frames;
}

function unpad_frame_data(frame) {
    if (frame.flags & DATA_FLAGS.PADDED) {
        const padlen = parse_uint8(frame.data, 0);
        if (padlen > frame.data.length + 1) {
            throw new Error('Invalid data padding length');
        }
        return frame.data.slice(1, frame.data.length - padlen);
    }
    return frame.data;
}

function find_previous_data_frame(merged, frame) {
    for (let i = 0; i < merged.length; i++) {
        const candidate = merged[i];
        if (candidate.type === FRAME_TYPES.DATA &&
            candidate.sysid === frame.sysid) {
            return candidate;
        }
    }
    return null;
}

function merge_frames_data(frames) {
    const merged = [];
    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        if (frame.type === FRAME_TYPES.DATA) {
            frame.data = unpad_frame_data(frame);
            const previous = find_previous_data_frame(merged, frame);
            if (previous === null) {
                merged.push(frame);
            } else {
                previous.data = Buffer.concat([previous.data, frame.data]);
            }
        } else {
            merged.push(frame);
        }
    }
    return merged;
}

function frame_type_string(code) {
    for (let key in FRAME_TYPES) {
        if (FRAME_TYPES.hasOwnProperty(key) && FRAME_TYPES[key] == code) {
            return key;
        }
    }
    return 'UNKNOWN';
}

function dump_data(flags, data) {
    try {
        const gunzipped = zlib.gunzipSync(data).toString('utf8');
        try {
            console.log(JSON.stringify(JSON.parse(gunzipped), null, 4));
        } catch (err) {
            console.log(gunzipped);
        }
    } catch (err2) {
        console.log('raw: ' + data.toString('hex'));
    }
}

function print_frame(frame) {
    console.log('frame -> type:' + frame_type_string(frame.type) + ', flags:' +
        frame.flags + ', sysid:' + frame.sysid + ', length:' + frame.data.length);
    switch (frame.type) {
        case FRAME_TYPES.HEADERS:
            console.log(JSON.stringify(frame.data, null, 4));
            break;
        case FRAME_TYPES.DATA:
            dump_data(frame.flags, frame.data);
            break;
    }
}

function print_frames(frames) {
    for (let i = 0; i < frames.length; i++) {
        print_frame(frames[i]);
    }
}

function dump_task(filepath) {
    const array = fs.readFileSync(filepath);
    const frames = extract_frames(array);
    const defrag = defrag_frames(frames);
    decompress_frames(defrag);
    const merged = merge_frames_data(defrag);
    print_frames(merged);
}

function startup() {
    if (process.argv.length !== 3) {
        console.log('usage: h2dump log-file');
        process.exit(1);
        return;
    }
    try {
        dump_task(process.argv[2]);
    } catch (err) {
        console.log(err);
        console.log('operation failed.');
        process.exit(1);
        return;
    }
}

startup();