/* HTTP/2 Binary Split */

/* jshint esversion: 6 */
/* jshint node: true */
"use strict";

const fs = require('fs'),
    path = require('path');

function parse_uint32_be(array, pos) {
    return (array[pos] << 24) |
        (array[pos + 1] << 16) |
        (array[pos + 2] << 8) |
        array[pos + 3];
}

function parse_uint8(array, pos) {
    return array[pos];
}

function extract_chunk(array, pos, directory) {
    if (array[pos] !== 0x4c || array[pos + 1] !== 0x6f || array[pos + 2] !== 0x67) {
        console.log('invalid chunk magic');
        console.log(pos);
        console.log(array[pos]);
        return -1;
    }
    pos += 3;
    const opcode = String.fromCharCode(parse_uint8(array, pos));
    pos++;
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
    fs.appendFileSync(path.join(directory, "" + fd), array.slice(pos - 20, limit));
    return len + 20;
}

function split_task(array, directory) {
    let pos = 0;
    while(pos + 20 < array.length) {
        const ret = extract_chunk(array, pos, directory);
        if (ret < 0) {
            return -1;
        }
        pos += ret;
    }
    return 0;
}

function startup() {
    console.log('h2split');
    if (process.argv.length !== 4) {
        console.log('usage: h2split log-file directory');
        process.exit(1);
        return;
    }
    const filepath = process.argv[2];
    const directory = process.argv[3];
    const array = fs.readFileSync(filepath);
    const ret = split_task(array, directory);
    if (ret < 0) {
        console.log('Error: ' + filepath);
        process.exit(1);
        return;
    }
}

startup();
