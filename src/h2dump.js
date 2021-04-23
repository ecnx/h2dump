/* HTTP/2 Binary Data Dump */

/* jshint esversion: 6 */
/* jshint node: true */
"use strict";

const fs = require('fs'),
    zlib = require('zlib'),
    HPACK   = require('hpack');

let codec = new HPACK();

const frame_types = {
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

function parse_uint8(array, pos) {
    return array[pos];
}

function frame_type_string(code) {
    for (let key in frame_types) {
        if (frame_types.hasOwnProperty(key) && frame_types[key] == code) {
            return key;
        }
    }
    return 'UNKNOWN';
}


function array_starts(array1, array2) {
    for (let i  = 0; i < array2.length; i++) {
        if (array1[i] != array2[i]) {
            return false;
        }
    }
    return true;
}

function dump_preface(array, pos, limit) {
    const preface = Buffer.from('505249202a20485454502f322e300d0a0d0a534d0d0a0d0a', 'hex');
    if (preface.length <= array.length) {
        if (array_starts(array.slice(pos, pos + preface.length), preface)) {
            console.log('  -- http2 preface string');
            return preface.length;
        }
    }
    return 0;
}

const last_header = [];

function dump_frame(array, pos) {
    const len = parse_uint24_be(array, pos);
    if (len < 0) {
        return -1;
    }

    pos += 3;
    const type = parse_uint8(array, pos);
    pos++;
    const flags = parse_uint8(array, pos++);
    const sysid = parse_uint32_be(array, pos) & 0x7fffffff;
    pos += 4;

    if (sysid < 256) {
        while (last_header.length <= sysid) {
            last_header.push(false);
        }
    }

    console.log('---- frame: type:' + type + ' (' + frame_type_string(type) + '), flags:' + flags + ', sysid: ' + sysid + ', len:' + len + ' ----')
    if ([frame_types.HEADERS, frame_types.DATA, frame_types.CONTINUATION].includes(type) && len > 0) {
        const data = array.slice(pos, pos+len);
        try {
            if (type === frame_types.HEADERS || (type === frame_types.CONTINUATION && last_header[sysid] === true))
            {
                console.log(JSON.stringify(codec.decode(data), null, 4));
            } else {
                throw new Error();
            }
        } catch (err) {
            console.log(err);
            try {
                const gunzipped = zlib.gunzipSync(data).toString('utf8');
                try {
                    console.log(JSON.stringify(JSON.parse(gunzipped), null, 4));
                } catch (err3) {
                    console.log(gunzipped);
                }
            } catch (err2) {
                console.log('  -- data not hpacked nor gzipped.');
                console.log('raw: ' + data.toString('hex'));
            }
        }
    }

    if (sysid < 256) {
        last_header[sysid] = (type === frame_types.HEADERS);
    }

    return len + 9;
}

function push_chunk(array, pos, chunks) {
    if (array[pos] !== 0x4c || array[pos + 1] !== 0x6f || array[pos + 2] !== 0x67) {
        console.log('invalid chunk magic');
        return -1;
    }
    pos += 3;
    const opcode = String.fromCharCode(parse_uint8(array, pos++));
    const fd = parse_uint32_be(array, pos);;
    pos += 4;
    const sec = parse_uint32_be(array, pos);
    pos += 4;
    const nsec = parse_uint32_be(array, pos);
    pos += 4;
    const len = parse_uint32_be(array, pos);
    pos += 4;
    const limit = pos + len;
    console.log('==== opcode: ' + opcode + ', sec:' + sec +
        ', nsec:' + nsec + ', pos: ' + pos + ', len: ' + len + ' ====');
    if (len < 0 || pos + len > array.length) {
        console.log('invalid chunk length');
        return -1;
    }
    chunks.push(array.slice(pos, limit));
    return len + 20;
}

function dump_task(array) {
    const chunks = [];
    let pos = 0;
    while(pos + 20 < array.length) {
        const ret = push_chunk(array, pos, chunks);
        if (ret < 0) {
            return -1;
        }
        pos += ret;
    }
    const connected = Buffer.concat(chunks);
    pos = 0;
    while (pos + 9 < connected.length) {
        let ret = dump_preface(connected, pos);
        if (ret === 0) {
            ret = dump_frame(connected, pos);
        }
        if (ret < 0) {
            return -1;
        }
        pos += ret;
    }
    return 0;
}

function startup() {
    console.log('h2dump');
    if (process.argv.length !== 3) {
        console.log('usage: h2dump log-file');
        process.exit(1);
        return;
    }
    const filepath = process.argv[2];
    const array = fs.readFileSync(filepath);
    const ret = dump_task(array);
    if (ret < 0) {
        console.log('Error: ' + filepath);
        process.exit(1);
        return;
    }
}

startup();
