import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {formatBytes, formatDuration} from './stats.js';

const CORES_PER_LINE = 4;

function addHeader(section, title) {
    const label = new St.Label({
        text: title,
        style_class: 'panel-stats-header',
    });
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    item.add_child(label);
    section.addMenuItem(item);
}

function addRow(section, title) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const box = new St.BoxLayout({
        style_class: 'panel-stats-row',
        x_expand: true,
        orientation: Clutter.Orientation.HORIZONTAL,
    });
    const name = new St.Label({
        text: title,
        style_class: 'panel-stats-row-name',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const value = new St.Label({
        text: '-',
        style_class: 'panel-stats-row-value',
        y_align: Clutter.ActorAlign.CENTER,
    });
    box.add_child(name);
    box.add_child(value);
    item.add_child(box);
    section.addMenuItem(item);
    return value;
}

function formatCores(cores) {
    const lines = [];
    for (let i = 0; i < cores.length; i += CORES_PER_LINE) {
        const line = cores
            .slice(i, i + CORES_PER_LINE)
            .map((value, offset) => `#${String(i + offset).padStart(2, '0')} ${`${Math.round(value)}%`.padStart(4, ' ')}`)
            .join('   ');
        lines.push(line);
    }
    return lines.join('\n');
}

/** Detailed statistics shown inside the indicator popup menu. */
export class DetailsMenu {
    constructor(menu) {
        this._menu = menu;
        this._rows = {};
        this._interfaceRows = new Map();
        this._deviceRows = new Map();
        this._buildCpu();
        this._buildMemory();
        this._buildNetwork();
        this._buildDisk();
    }

    _section() {
        const section = new PopupMenu.PopupMenuSection();
        this._menu.addMenuItem(section);
        return section;
    }

    _buildCpu() {
        const section = this._section();
        addHeader(section, _('Processor'));
        this._rows.cpu = addRow(section, _('Total load'));
        this._rows.temperature = addRow(section, _('Temperature'));
        this._rows.load = addRow(section, _('Load average'));
        this._rows.uptime = addRow(section, _('Uptime'));
        this._rows.processes = addRow(section, _('Processes'));

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._rows.cores = new St.Label({text: '', style_class: 'panel-stats-cores'});
        this._rows.cores.clutter_text.line_wrap = false;
        item.add_child(this._rows.cores);
        section.addMenuItem(item);
    }

    _buildMemory() {
        const section = this._section();
        section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        addHeader(section, _('Memory'));
        this._rows.memory = addRow(section, _('Used'));
        this._rows.memoryAvailable = addRow(section, _('Available'));
        this._rows.memoryCached = addRow(section, _('Cached'));
        this._rows.swap = addRow(section, _('Swap'));
    }

    _buildNetwork() {
        const section = this._section();
        section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        addHeader(section, _('Network'));
        this._rows.netSpeed = addRow(section, _('Speed'));
        this._rows.netTotal = addRow(section, _('Transferred'));
        this._networkSection = this._section();
    }

    _buildDisk() {
        const section = this._section();
        section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        addHeader(section, _('Disk'));
        this._rows.diskUsage = addRow(section, _('Root filesystem'));
        this._rows.diskFree = addRow(section, _('Free'));
        this._rows.diskIo = addRow(section, _('Read / write'));
        this._diskSection = this._section();
    }

    _updateDynamicRows(section, cache, entries, format) {
        if (cache.size !== entries.length || entries.some(entry => !cache.has(entry.name))) {
            section.removeAll();
            cache.clear();
            for (const entry of entries)
                cache.set(entry.name, addRow(section, entry.name));
        }
        for (const entry of entries)
            cache.get(entry.name).set_text(format(entry));
    }

    /**
     * Writes a fresh sample into every row of the menu.
     *
     * @param {object} data - sample produced by the indicator
     */
    update(data) {
        const {cpu, memory, net, disk, system, temperature} = data;

        this._rows.cpu.set_text(`${cpu.total.toFixed(1)} %`);
        this._rows.cores.set_text(formatCores(cpu.cores));
        this._rows.temperature.set_text(temperature !== null ? `${temperature.toFixed(1)} °C` : _('unavailable'));
        this._rows.load.set_text(system.load.map(value => value.toFixed(2)).join('  '));
        this._rows.uptime.set_text(formatDuration(system.uptime));
        this._rows.processes.set_text(`${system.processes} (${system.running} ${_('running')})`);

        this._rows.memory.set_text(
            `${memory.usedPercent.toFixed(1)} %  ·  ${formatBytes(memory.used)} / ${formatBytes(memory.total)}`);
        this._rows.memoryAvailable.set_text(formatBytes(memory.available));
        this._rows.memoryCached.set_text(formatBytes(memory.cached));
        this._rows.swap.set_text(memory.swapTotal > 0
            ? `${memory.swapPercent.toFixed(1)} %  ·  ${formatBytes(memory.swapUsed)} / ${formatBytes(memory.swapTotal)}`
            : _('disabled'));

        this._rows.netSpeed.set_text(`↓ ${formatBytes(net.down, '/s')}   ↑ ${formatBytes(net.up, '/s')}`);
        this._rows.netTotal.set_text(`↓ ${formatBytes(net.received)}   ↑ ${formatBytes(net.sent)}`);
        this._updateDynamicRows(this._networkSection, this._interfaceRows, net.interfaces,
            iface => `↓ ${formatBytes(iface.down, '/s')}   ↑ ${formatBytes(iface.up, '/s')}`);

        this._rows.diskUsage.set_text(
            `${disk.usedPercent.toFixed(1)} %  ·  ${formatBytes(disk.used)} / ${formatBytes(disk.total)}`);
        this._rows.diskFree.set_text(formatBytes(disk.free));
        this._rows.diskIo.set_text(`${formatBytes(disk.read, '/s')}   ${formatBytes(disk.write, '/s')}`);
        this._updateDynamicRows(this._diskSection, this._deviceRows, disk.devices,
            device => `${formatBytes(device.read, '/s')}   ${formatBytes(device.write, '/s')}`);
    }
}
