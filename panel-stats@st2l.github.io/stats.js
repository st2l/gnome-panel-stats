import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const SECTOR_SIZE = 512;
const PHYSICAL_DISK = /^(sd[a-z]+|nvme\d+n\d+|mmcblk\d+|vd[a-z]+|hd[a-z]+)$/;
const IGNORED_IFACE = /^(lo|docker|veth|br-|virbr|vmnet|dummy)/;
const TEMP_LABELS = ['Package id 0', 'Tctl', 'Tdie', 'CPU', 'cpu_thermal'];

/**
 * Reads a whole file as text.
 *
 * @param {string} path - absolute path of the file to read
 * @returns {?string} file contents, or null if the file is unreadable
 */
export function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

/**
 * Formats a byte count with binary (1024-based) units.
 *
 * @param {number} bytes - value to format
 * @param {string} [suffix] - string appended to the unit, e.g. '/s'
 * @returns {string} human readable size such as '1.4 GiB'
 */
export function formatBytes(bytes, suffix = '') {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = Math.max(bytes, 0);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const digits = value < 10 && unit > 0 ? 1 : 0;
    return `${value.toFixed(digits)} ${units[unit]}${suffix}`;
}

/**
 * Formats a duration in seconds as a compact '3d 4h 5m' string.
 *
 * @param {number} seconds - duration to format
 * @returns {string} compact duration
 */
export function formatDuration(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0)
        return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function cpuTimes() {
    const text = readText('/proc/stat');
    if (text === null)
        return [];

    const cpus = [];
    for (const line of text.split('\n')) {
        if (!line.startsWith('cpu'))
            break;
        const fields = line.split(/\s+/);
        const name = fields[0];
        const values = fields.slice(1).map(Number).filter(n => Number.isFinite(n));
        if (values.length < 5)
            continue;
        let total = 0;
        for (const value of values)
            total += value;
        cpus.push({name, total, busy: total - values[3] - (values[4] ?? 0)});
    }
    return cpus;
}

/** Percentage CPU load for the whole package and for every core. */
export class CpuReader {
    constructor() {
        this._previous = cpuTimes();
    }

    /**
     * Samples /proc/stat and returns the load since the previous sample.
     *
     * @returns {{total: number, cores: number[]}} load percentages
     */
    read() {
        const current = cpuTimes();
        const result = {total: 0, cores: []};

        for (let i = 0; i < current.length; i++) {
            const now = current[i];
            const before = this._previous[i];
            let percent = 0;
            if (before !== undefined && before.name === now.name) {
                const deltaTotal = now.total - before.total;
                const deltaBusy = now.busy - before.busy;
                if (deltaTotal > 0)
                    percent = Math.min(100, Math.max(0, (deltaBusy / deltaTotal) * 100));
            }
            if (i === 0)
                result.total = percent;
            else
                result.cores.push(percent);
        }

        this._previous = current;
        return result;
    }
}

/**
 * Reads memory and swap usage from /proc/meminfo.
 *
 * @returns {{usedPercent: number, used: number, total: number,
 *   available: number, cached: number, swapPercent: number,
 *   swapUsed: number, swapTotal: number}} memory usage in bytes and percent
 */
export function readMemory() {
    const text = readText('/proc/meminfo') ?? '';
    const values = new Map();
    for (const line of text.split('\n')) {
        const match = /^(\w+):\s+(\d+)/.exec(line);
        if (match !== null)
            values.set(match[1], Number(match[2]) * 1024);
    }

    const total = values.get('MemTotal') ?? 0;
    const available = values.get('MemAvailable') ?? 0;
    const swapTotal = values.get('SwapTotal') ?? 0;
    const swapFree = values.get('SwapFree') ?? 0;
    const used = Math.max(total - available, 0);
    const swapUsed = Math.max(swapTotal - swapFree, 0);

    return {
        usedPercent: total > 0 ? (used / total) * 100 : 0,
        used,
        total,
        available,
        cached: (values.get('Cached') ?? 0) + (values.get('Buffers') ?? 0),
        swapPercent: swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0,
        swapUsed,
        swapTotal,
    };
}

function netCounters() {
    const text = readText('/proc/net/dev') ?? '';
    const counters = new Map();
    for (const line of text.split('\n')) {
        const match = /^\s*([\w.@-]+):\s*(.*)$/.exec(line);
        if (match === null)
            continue;
        const fields = match[2].split(/\s+/).map(Number);
        if (fields.length < 10)
            continue;
        counters.set(match[1], {received: fields[0], sent: fields[8]});
    }
    return counters;
}

function isPhysicalInterface(name) {
    return Gio.File.new_for_path(`/sys/class/net/${name}/device`).query_exists(null);
}

function sumInterfaces(interfaces) {
    const totals = {down: 0, up: 0, received: 0, sent: 0};
    for (const iface of interfaces) {
        totals.down += iface.down;
        totals.up += iface.up;
        totals.received += iface.received;
        totals.sent += iface.sent;
    }
    return totals;
}

/**
 * Download and upload rates, in total and per interface.
 *
 * Totals cover physical interfaces only, so VPN tunnels carried over a
 * physical link are not counted twice. Tunnels are still listed separately.
 */
export class NetReader {
    constructor() {
        this._previous = netCounters();
        this._timestamp = GLib.get_monotonic_time();
        this._physical = new Map();
    }

    _isPhysical(name) {
        if (!this._physical.has(name))
            this._physical.set(name, isPhysicalInterface(name));
        return this._physical.get(name);
    }

    /**
     * Samples /proc/net/dev and returns rates since the previous sample.
     *
     * @returns {{down: number, up: number, received: number, sent: number,
     *   interfaces: Array<object>}} rates in bytes per second plus totals
     */
    read() {
        const current = netCounters();
        const now = GLib.get_monotonic_time();
        const elapsed = Math.max((now - this._timestamp) / 1e6, 0.001);
        const interfaces = [];

        for (const [name, counter] of current) {
            if (IGNORED_IFACE.test(name))
                continue;
            const before = this._previous.get(name);
            interfaces.push({
                name,
                physical: this._isPhysical(name),
                down: before ? Math.max(counter.received - before.received, 0) / elapsed : 0,
                up: before ? Math.max(counter.sent - before.sent, 0) / elapsed : 0,
                received: counter.received,
                sent: counter.sent,
            });
        }

        interfaces.sort((a, b) => b.down + b.up - (a.down + a.up));
        const physical = interfaces.filter(iface => iface.physical);
        const totals = sumInterfaces(physical.length > 0 ? physical : interfaces);

        this._previous = current;
        this._timestamp = now;
        return {...totals, interfaces};
    }
}

function diskCounters() {
    const text = readText('/proc/diskstats') ?? '';
    const counters = new Map();
    for (const line of text.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10 || !PHYSICAL_DISK.test(fields[2]))
            continue;
        counters.set(fields[2], {
            read: Number(fields[5]) * SECTOR_SIZE,
            write: Number(fields[9]) * SECTOR_SIZE,
        });
    }
    return counters;
}

function filesystemUsage(path) {
    try {
        const info = Gio.File.new_for_path(path).query_filesystem_info('filesystem::*', null);
        const total = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        const used = Math.max(total - free, 0);
        return {
            path,
            total,
            free,
            used,
            usedPercent: total > 0 ? (used / total) * 100 : 0,
        };
    } catch {
        return {path, total: 0, free: 0, used: 0, usedPercent: 0};
    }
}

/** Root filesystem usage plus read and write throughput per device. */
export class DiskReader {
    constructor() {
        this._previous = diskCounters();
        this._timestamp = GLib.get_monotonic_time();
    }

    /**
     * Samples /proc/diskstats and the root filesystem.
     *
     * @returns {{usedPercent: number, used: number, total: number,
     *   free: number, read: number, write: number, devices: Array<object>}}
     *   usage in bytes and throughput in bytes per second
     */
    read() {
        const current = diskCounters();
        const now = GLib.get_monotonic_time();
        const elapsed = Math.max((now - this._timestamp) / 1e6, 0.001);
        const usage = filesystemUsage('/');
        const result = {...usage, read: 0, write: 0, devices: []};

        for (const [name, counter] of current) {
            const before = this._previous.get(name);
            const read = before ? Math.max(counter.read - before.read, 0) / elapsed : 0;
            const write = before ? Math.max(counter.write - before.write, 0) / elapsed : 0;
            result.read += read;
            result.write += write;
            result.devices.push({name, read, write});
        }

        result.devices.sort((a, b) => b.read + b.write - (a.read + a.write));
        this._previous = current;
        this._timestamp = now;
        return result;
    }
}

function findHwmonFile() {
    const base = '/sys/class/hwmon';
    for (const label of TEMP_LABELS) {
        for (const entry of listDirectory(base)) {
            const path = matchHwmonLabel(`${base}/${entry}`, label);
            if (path !== null)
                return path;
        }
    }
    return null;
}

function listDirectory(path) {
    const names = [];
    try {
        const dir = GLib.Dir.open(path, 0);
        let name = dir.read_name();
        while (name !== null) {
            names.push(name);
            name = dir.read_name();
        }
        dir.close();
    } catch {
        return names;
    }
    names.sort();
    return names;
}

function matchHwmonLabel(directory, wanted) {
    for (const name of listDirectory(directory)) {
        if (!name.endsWith('_label'))
            continue;
        const label = readText(`${directory}/${name}`)?.trim();
        if (label !== wanted)
            continue;
        const path = `${directory}/${name.replace('_label', '_input')}`;
        if (readText(path) !== null)
            return path;
    }
    return null;
}

function findThermalZoneFile() {
    const base = '/sys/class/thermal';
    for (const entry of listDirectory(base)) {
        if (!entry.startsWith('thermal_zone'))
            continue;
        const type = readText(`${base}/${entry}/type`)?.trim() ?? '';
        if (!/x86_pkg_temp|cpu|soc|acpitz/i.test(type))
            continue;
        const path = `${base}/${entry}/temp`;
        if (readText(path) !== null)
            return path;
    }
    return null;
}

/** Best-effort CPU temperature, reading a sensor file resolved once. */
export class TemperatureReader {
    constructor() {
        this._path = findHwmonFile() ?? findThermalZoneFile();
    }

    /**
     * Reads the CPU temperature.
     *
     * @returns {?number} degrees Celsius, or null when no sensor is readable
     */
    read() {
        if (this._path === null)
            return null;
        const value = readText(this._path);
        if (value === null) {
            this._path = null;
            return null;
        }
        return Number(value.trim()) / 1000;
    }
}

/**
 * Reads load average, uptime and process counts.
 *
 * @returns {{load: number[], uptime: number, processes: number,
 *   running: number}} system load information
 */
export function readSystem() {
    const loadText = readText('/proc/loadavg') ?? '';
    const loadFields = loadText.trim().split(/\s+/);
    const uptimeText = readText('/proc/uptime') ?? '';
    const running = /^(\d+)\/(\d+)$/.exec(loadFields[3] ?? '');

    return {
        load: [0, 1, 2].map(i => Number(loadFields[i] ?? 0)),
        uptime: Number(uptimeText.trim().split(/\s+/)[0] ?? 0),
        processes: running !== null ? Number(running[2]) : 0,
        running: running !== null ? Number(running[1]) : 0,
    };
}
