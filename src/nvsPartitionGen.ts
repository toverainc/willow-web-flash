import * as crc32 from 'crc-32'

function toInt(val: string | number | bigint): number {
    return parseInt("" + val)
}

class Page {
    static U8 = 0x01;
    static I8 = 0x11;
    static U16 = 0x02;
    static I16 = 0x12;
    static U32 = 0x04;
    static I32 = 0x14;
    static U64 = 0x08;
    static I64 = 0x18;
    static SZ = 0x21;
    static BLOB = 0x41;
    static BLOB_DATA = 0x42;
    static BLOB_IDX = 0x48;

    static HEADER_SIZE = 32;
    static BITMAPARRAY_OFFSET = 32;
    static BITMAPARRAY_SIZE_IN_BYTES = 32;
    static FIRST_ENTRY_OFFSET = 64;
    static SINGLE_ENTRY_SIZE = 32;
    static CHUNK_ANY = 0xFF;
    static ACTIVE = 0xFFFFFFFE;
    static FULL = 0xFFFFFFFC;
    static VERSION1 = 0xFF;
    static VERSION2 = 0xFE;
    static PAGE_PARAMS = {
        max_size: 4096,
        max_blob_size: { [Page.VERSION1]: 1984, [Page.VERSION2]: 4000 },
        max_entries: 126
    };

    entry_num: number;
    bitmap_array: Uint8Array;
    version: number;
    page_buf: Uint8Array;

    constructor(page_num: number, version: number, is_rsrv_page: boolean = false) {
        this.entry_num = 0;
        this.bitmap_array = new Uint8Array();
        this.version = version;
        this.page_buf = new Uint8Array(Page.PAGE_PARAMS.max_size).fill(0xFF);
        if (!is_rsrv_page) {
            this.bitmap_array = this.create_bitmap_array();
            this.set_header(page_num, version);
        }
    }

    set_header(page_num: number, version: number): void {
        const page_header = new Uint8Array(32).fill(0xFF);
        const page_state_active_seq = Page.ACTIVE;
        page_header.set(new Uint8Array(new Uint32Array([page_state_active_seq]).buffer), 0);

        page_header.set(new Uint8Array(new Uint32Array([page_num]).buffer), 4);

        if (version === Page.VERSION2) {
            page_header[8] = Page.VERSION2;
        } else if (version === Page.VERSION1) {
            page_header[8] = Page.VERSION1;
        }

        const crc_data = page_header.slice(4, 28);
        const crc = crc32.buf(crc_data, 0xFFFFFFFF)
        page_header.set(new Uint8Array(new Uint32Array([crc & 0xFFFFFFFF]).buffer), 28);

        this.page_buf.set(page_header, 0);
    }

    create_bitmap_array(): Uint8Array {
        const charsize = 32;
        const fill = 255;
        return new Uint8Array(charsize).fill(fill);
    }

    write_bitmaparray(): void {
        const bitnum = this.entry_num * 2;
        const byte_idx = Math.floor(bitnum / 8);
        const bit_offset = bitnum & 7;
        const mask = ~(1 << bit_offset);
        this.bitmap_array[byte_idx] &= mask;
        const start_idx = Page.BITMAPARRAY_OFFSET;
        //const end_idx = Page.BITMAPARRAY_OFFSET + Page.BITMAPARRAY_SIZE_IN_BYTES;
        this.page_buf.set(this.bitmap_array.slice(0, Page.BITMAPARRAY_SIZE_IN_BYTES), start_idx);
    }

    write_entry_to_buf(data: Uint8Array, entrycount: number, nvs_obj: NVS): void {
        const data_offset = Page.FIRST_ENTRY_OFFSET + (Page.SINGLE_ENTRY_SIZE * this.entry_num);
        const start_idx = data_offset;
        //const end_idx = data_offset + data.length;
        this.page_buf.set(data, start_idx);

        for (let i = 0; i < entrycount; i++) {
            this.write_bitmaparray();
            this.entry_num += 1;
        }
    }

    set_crc_header(entry_struct: Uint8Array): Uint8Array {
        const crc_data = new Uint8Array(28);
        crc_data.set(entry_struct.slice(0, 4), 0);
        crc_data.set(entry_struct.slice(8, 32), 4);
        const crc = crc32.buf(crc_data, 0xFFFFFFFF);
        entry_struct.set(new Uint8Array(new Uint32Array([crc & 0xFFFFFFFF]).buffer), 4);
        return entry_struct;
    }

    write_varlen_binary_data(entry_struct: Uint8Array, ns_index: number, key: string, data: Uint8Array | string, data_size: number, total_entry_count: number, encoding: string, nvs_obj: NVS): Uint8Array {
        let chunk_start = 0;
        let chunk_count = 0;
        let chunk_index = Page.CHUNK_ANY;
        let offset = 0;
        let remaining_size = data_size;
        let tailroom: number | null = null;
        let self: Page = this;
        while (true) {
            let chunk_size = 0;

            tailroom = (Page.PAGE_PARAMS.max_entries - self.entry_num - 1) * Page.SINGLE_ENTRY_SIZE;
            if (tailroom < 0) {
                throw new Error('Page overflow!!');
            }

            if (tailroom < remaining_size) {
                chunk_size = tailroom;
            } else {
                chunk_size = remaining_size;
            }
            remaining_size = remaining_size - chunk_size;

            entry_struct[1] = Page.BLOB_DATA;

            const datachunk_rounded_size = (chunk_size + 31) & ~31;
            const datachunk_entry_count = datachunk_rounded_size / 32;
            const datachunk_total_entry_count = datachunk_entry_count + 1;

            entry_struct[2] = datachunk_total_entry_count;

            chunk_index = chunk_start + chunk_count;
            entry_struct[3] = chunk_index;

            let data_chunk = data.slice(offset, offset + chunk_size);

            entry_struct.set(new Uint8Array(new Uint16Array([chunk_size]).buffer), 24);
            if (typeof data_chunk === "string") {
                data_chunk = new TextEncoder().encode(data_chunk)
            }
            const crc = crc32.buf(data_chunk, 0xFFFFFFFF);
            entry_struct.set(new Uint8Array(new Uint32Array([crc & 0xFFFFFFFF]).buffer), 28);

            entry_struct = self.set_crc_header(entry_struct);

            self.write_entry_to_buf(entry_struct, 1, nvs_obj);

            self.write_entry_to_buf(data_chunk, datachunk_entry_count, nvs_obj);
            chunk_count = chunk_count + 1;
            if (remaining_size || (tailroom - chunk_size) < Page.SINGLE_ENTRY_SIZE) {
                nvs_obj.create_new_page();
                self = nvs_obj.cur_page;
            }
            offset = offset + chunk_size;

            if (!remaining_size) {

                const data_array = new Uint8Array(8).fill(0xFF);
                entry_struct.set(data_array, 24);

                entry_struct[1] = Page.BLOB_IDX;

                entry_struct[2] = 1;

                chunk_index = Page.CHUNK_ANY;
                entry_struct[3] = chunk_index;
                entry_struct.set(new Uint8Array(new Uint32Array([data_size]).buffer), 24);
                entry_struct[28] = chunk_count;
                entry_struct[29] = chunk_start;

                entry_struct = self.set_crc_header(entry_struct);

                self.write_entry_to_buf(entry_struct, 1, nvs_obj);
                break;
            }
        }
        return entry_struct;
    }

    write_single_page_entry(entry_struct: Uint8Array, data: Uint8Array | string, datalen: number, data_entry_count: number, nvs_obj: NVS): void {
        entry_struct.set(new Uint8Array(new Uint16Array([datalen]).buffer), 24);
        if (!(data instanceof Uint8Array)) {
            data = new TextEncoder().encode(data)
        }
        const crc = crc32.buf(data, 0xFFFFFFFF);
        entry_struct.set(new Uint8Array(new Uint32Array([crc & 0xFFFFFFFF]).buffer), 28);

        entry_struct = this.set_crc_header(entry_struct);

        this.write_entry_to_buf(entry_struct, 1, nvs_obj);

        this.write_entry_to_buf(data, data_entry_count, nvs_obj);
    }

    write_varlen_data(key: string, data: Uint8Array | string, encoding: string, ns_index: number, nvs_obj: NVS): void {
        const datalen = data.length;
        const max_blob_size = Page.PAGE_PARAMS.max_blob_size[this.version];

        const blob_limit_applies = this.version === Page.VERSION1 || encoding === 'string';
        if (blob_limit_applies && datalen > (max_blob_size || 1984)) {
            throw new Error(`Input File: Size (${datalen}) exceeds max allowed length \`${max_blob_size}\` bytes for key \`${key}\`.`);
        }

        const rounded_size = (datalen + 31) & ~31;
        const data_entry_count = rounded_size / 32;
        const total_entry_count = data_entry_count + 1;

        if (this.entry_num >= Page.PAGE_PARAMS.max_entries) {
            throw new PageFullError();
        } else if ((this.entry_num + total_entry_count) >= Page.PAGE_PARAMS.max_entries) {
            if (!(this.version === Page.VERSION2 && ['hex2bin', 'binary', 'base64'].includes(encoding))) {
                throw new PageFullError();
            }
        }

        let entry_struct = new Uint8Array(32).fill(0xFF);

        entry_struct[0] = ns_index;

        if (this.version === Page.VERSION2) {
            if (encoding === 'string') {
                entry_struct[2] = data_entry_count + 1;
            }

            let chunk_index = Page.CHUNK_ANY;
            entry_struct[3] = chunk_index;
        } else {
            entry_struct[2] = data_entry_count + 1;
        }

        const key_array = new Uint8Array(16).fill(0x00);
        entry_struct.set(key_array, 8);
        entry_struct.set(new TextEncoder().encode(key), 8);

        if (encoding === 'string') {
            entry_struct[1] = Page.SZ;
        } else if (['hex2bin', 'binary', 'base64'].includes(encoding)) {
            entry_struct[1] = Page.BLOB;
        }
        if (this.version === Page.VERSION2 && (['hex2bin', 'binary', 'base64'].includes(encoding))) {
            entry_struct = this.write_varlen_binary_data(entry_struct, ns_index, key, data,
                datalen, total_entry_count, encoding, nvs_obj);
        } else {
            this.write_single_page_entry(entry_struct, data, datalen, data_entry_count, nvs_obj);
        }
    }

    write_primitive_data(key: string, data: number | bigint | string, encoding: string, ns_index: number, nvs_obj: NVS): void {
        if (this.entry_num >= Page.PAGE_PARAMS.max_entries) {
            throw new PageFullError();
        }
        const entry_struct = new Uint8Array(32).fill(0xFF);
        entry_struct[0] = ns_index;
        entry_struct[2] = 0x01;
        let chunk_index = Page.CHUNK_ANY;
        entry_struct[3] = chunk_index;

        const key_array = new Uint8Array(16).fill(0x00);
        entry_struct.set(key_array, 8);
        entry_struct.set(new TextEncoder().encode(key), 8)

        if (encoding === 'u8') {
            entry_struct[1] = Page.U8;
            entry_struct.set(new Uint8Array(new Uint8Array([toInt(data)]).buffer), 24);
        } else if (encoding === 'i8') {
            entry_struct[1] = Page.I8;
            entry_struct.set(new Uint8Array(new Int8Array([toInt(data)]).buffer), 24);
        } else if (encoding === 'u16') {
            entry_struct[1] = Page.U16;
            entry_struct.set(new Uint8Array(new Uint16Array([toInt(data)]).buffer), 24);
        } else if (encoding === 'i16') {
            entry_struct[1] = Page.I16;
            entry_struct.set(new Uint8Array(new Int16Array([toInt(data)]).buffer), 24);
        } else if (encoding === 'u32') {
            entry_struct[1] = Page.U32;
            entry_struct.set(new Uint8Array(new Uint32Array([toInt(data)]).buffer), 24);
        } else if (encoding === 'i32') {
            entry_struct[1] = Page.I32;
            entry_struct.set(new Uint8Array(new Int32Array([toInt(data)]).buffer), 24);
        } else if (encoding === 'u64') {
            entry_struct[1] = Page.U64;
            entry_struct.set(new Uint8Array(new BigUint64Array([BigInt(data)]).buffer), 24);
        } else if (encoding === 'i64') {
            entry_struct[1] = Page.I64;
            entry_struct.set(new Uint8Array(new BigInt64Array([BigInt(data)]).buffer), 24);
        }

        const crc_data = new Uint8Array(28);
        crc_data.set(entry_struct.slice(0, 4), 0);
        crc_data.set(entry_struct.slice(8, 32), 4);
        const crc = crc32.buf(crc_data, 0xFFFFFFFF);
        entry_struct.set(new Uint8Array(new Uint32Array([crc & 0xFFFFFFFF]).buffer), 4);

        this.write_entry_to_buf(entry_struct, 1, nvs_obj);
    }

    get_data(): Uint8Array {
        return this.page_buf;
    }
}

class NVS {
    size: number;
    namespace_idx: number;
    page_num: number;
    pages: Page[];
    version: number;
    cur_page: Page;

    constructor(input_size: number, version: number) {
        this.size = input_size;
        this.namespace_idx = 0;
        this.page_num = -1;
        this.pages = [];
        this.version = version;
        this.cur_page = this.create_new_page();
    }

    create_new_page(is_rsrv_page: boolean = false): Page {
        assert(this.size !== -1, "NVS is closed when you call get_binary_data(). No new pages can be added.")
        if (this.pages.length > 0) {
            const curr_page_state = new Uint32Array(this.cur_page.page_buf.buffer, 0, 1)[0];
            if (curr_page_state === Page.ACTIVE) {
                const page_state_full_seq = Page.FULL;
                new Uint32Array(this.cur_page.page_buf.buffer, 0, 1)[0] = page_state_full_seq;
            }
        }
        if (this.size === 0) {
            throw new InsufficientSizeError('Error: Size parameter is less than the size of data in csv. Please increase size.');
        }
        if (!is_rsrv_page) {
            this.size = this.size - Page.PAGE_PARAMS.max_size;
        }
        this.page_num += 1;

        const new_page = new Page(this.page_num, this.version, is_rsrv_page);
        this.pages.push(new_page);
        this.cur_page = new_page;
        return new_page;
    }

    write_namespace(key: string): void {
        this.namespace_idx += 1;
        try {
            this.cur_page.write_primitive_data(key, this.namespace_idx, 'u8', 0, this);
        } catch (error) {
            if (error instanceof PageFullError) {
                const new_page = this.create_new_page();
                new_page.write_primitive_data(key, this.namespace_idx, 'u8', 0, this);
            } else {
                throw error;
            }
        }
    }

    /**
     * Write key-value pair. Function accepts value in the form of ascii character and converts
     * it into appropriate format before calling Page class's functions to write entry into NVS format.
     * Function handles PageFullError and creates a new page and re-invokes the function on a new page.
     * We don't have to guard re-invocation with try-except since no entry can span multiple pages.
     */
    write_entry(key: string, _value: string, encoding: string): void {
        let value: string | Uint8Array = _value
        if (encoding === 'hex2bin') {
            value = value.trim();
            if (value.length % 2 !== 0) {
                throw new InputError(`${key}: Invalid data length. Should be multiple of 2.`);
            }
            //value = Buffer.from(value, 'hex');
            value = Uint8Array.from((_value.match(/.{1,2}/g) || []).map((byte) => parseInt(byte, 16)));
        } else if (encoding === 'base64') {
            //value = Buffer.from(value, 'base64');
            value = new Uint8Array(atob(_value).split("").map(function (c) { return c.charCodeAt(0); }))
        } else if (encoding === 'string') {
            value = '' + _value + '\0'; //C string :P
        }
        encoding = encoding.toLowerCase();
        const varlen_encodings = new Set(['string', 'binary', 'hex2bin', 'base64']);
        const primitive_encodings = new Set(['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64']);
        if (varlen_encodings.has(encoding)) {
            try {
                this.cur_page.write_varlen_data(key, value, encoding, this.namespace_idx, this);
            } catch (error) {
                if (error instanceof PageFullError) {
                    const new_page = this.create_new_page();
                    new_page.write_varlen_data(key, value, encoding, this.namespace_idx, this);
                } else {
                    throw error;
                }
            }
        } else if (primitive_encodings.has(encoding)) {
            assert(typeof value == "string") //make TS happy
            try {
                this.cur_page.write_primitive_data(key, value, encoding, this.namespace_idx, this);
            } catch (error) {
                if (error instanceof PageFullError) {
                    const new_page = this.create_new_page();
                    new_page.write_primitive_data(key, value, encoding, this.namespace_idx, this);
                } else {
                    throw error;
                }
            }
        } else {
            throw new InputError(`${key}: Unsupported encoding`);
        }
    }

    get_binary_data(): Uint8Array {
        // Create pages for remaining available size
        while (this.size !== -1) {
            try {
                this.create_new_page()
            } catch (error) {
                if (!(error instanceof InsufficientSizeError)) throw error;
                //Creating the last reserved page
                this.size = Number.MAX_SAFE_INTEGER
                this.create_new_page(true)
                this.size = -1
                break;
            }
        }
        let data = new Uint8Array();
        for (const page of this.pages) {
            data = new Uint8Array([...data, ...page.get_data()]);
        }
        return data;
    }
}

class PageFullError extends Error {
    constructor() {
        super();
        this.name = 'PageFullError';
    }
}

class InputError extends Error {
    constructor(e: string) {
        console.log('\nError:');
        super(e);
        this.name = 'InputError';
    }
}

class InsufficientSizeError extends Error {
    constructor(e: string) {
        super(e);
        this.name = 'InsufficientSizeError';
    }
}

class AssertionError extends Error {
    constructor(e?: string) {
        super(e);
        this.name = 'AssertionError';
    }
}

function assert(condition: unknown, msg?: string): asserts condition {
    if (condition === false) throw new AssertionError(msg)
}

function write_entry(nvs_instance: NVS, key: string, datatype: string, encoding: string, value: string): void {
    assert(datatype !== 'file', '"file" data type not implemented')
    if (datatype === 'namespace') {
        nvs_instance.write_namespace(key);
    } else {
        nvs_instance.write_entry(key, value, encoding);
    }
}

function check_size(input_size: number): number {
    if (input_size % 4096 !== 0) {
        throw new Error('Size of partition must be multiple of 4096');
    }
    input_size = input_size - Page.PAGE_PARAMS.max_size;
    if (input_size < (2 * Page.PAGE_PARAMS.max_size)) {
        throw new Error('Minimum NVS partition size needed is 0x3000 bytes.');
    }
    return input_size;
}

export interface NVSRow {
    key: string,
    type: "namespace" | "data", //"file" is not implemented
    encoding?: "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "u64" | "i64" | "string" | "hex2bin" | "base64" | "binary",
    value?: string,
}

export function generateNvs(version: number, size: number, data: NVSRow[]): Uint8Array {
    const input_size = check_size(size);
    if (version === 1) {
        version = Page.VERSION1;
    } else if (version === 2) {
        version = Page.VERSION2;
    }
    const nvs_obj = new NVS(input_size, version);
    for (const row of data) {
        const max_key_len = 15;
        if (row.key.length > max_key_len) {
            throw new InputError(`Length of key \`${row.key}\` should be <= 15 characters.`);
        }
        write_entry(nvs_obj, row.key, row.type, row.encoding || "", row.value || "");
    }
    return nvs_obj.get_binary_data();
}

//Testing code below
/*
async function urlAsUInt8Array(url:string):Promise<Uint8Array> {
    const buffer = await (await fetch(url)).arrayBuffer()
    return new Uint8Array(buffer)
}

const downloadURL = (data: any, fileName: any) => {
    const a = document.createElement('a')
    a.href = data
    a.download = fileName
    document.body.appendChild(a)
    a.style.display = 'none'
    a.click()
    a.remove()
}

const downloadBlob = (data: any, fileName: any, mimeType: any) => {
    const blob = new Blob([data], {
        type: mimeType
    })
    const url = window.URL.createObjectURL(blob)
    downloadURL(url, fileName)
    setTimeout(() => window.URL.revokeObjectURL(url), 1000)
}

window.addEventListener("load", async (event) => {
    const rows:NVSRow[] = [
        { key: "WIFI", type: "namespace" },
        { key: "PSK", type: "data", encoding: "string", value: "password123" },
        { key: "SSID", type: "data", encoding: "string", value: "yourwifiname" },
    ];

    const firmware = await urlAsUInt8Array('willow-dist-mod.bin')
    const nvs = generateNvs(Page.VERSION2, 0x24000, rows)
    firmware.set(nvs, 0x9000)
    downloadBlob(firmware, 'willow-dist-modded.bin', 'application/octet-stream');
});
*/