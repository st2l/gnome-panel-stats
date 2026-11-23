import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DetailsMenu} from './menu.js';
import {CpuReader, DiskReader, NetReader, TemperatureReader, readMemory, readSystem} from './stats.js';

const METRICS = ['cpu', 'memory', 'network', 'disk', 'temperature'];
const PREFIXES = {
    cpu: 'CPU',
    memory: 'RAM',
    network: 'NET',
    disk: 'DISK',
    temperature: 'TEMP',
};

function shortRate(bytesPerSecond) {
    const units = ['B', 'K', 'M', 'G'];
    let value = Math.max(bytesPerSecond, 0);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const digits = value < 10 && unit > 0 ? 1 : 0;
    return `${value.toFixed(digits)}${units[unit]}`;
}

function percent(value) {
    return `${String(Math.round(value)).padStart(2, ' ')}%`;
}

const StatsIndicator = GObject.registerClass(
class StatsIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Panel Stats'), false);

        this._settings = extension.getSettings();
        this._cpu = new CpuReader();
        this._net = new NetReader();
        this._disk = new DiskReader();
        this._temperature = new TemperatureReader();
        this._labels = new Map();
        this._timeoutId = 0;

        this._box = new St.BoxLayout({
            style_class: 'panel-stats-indicator',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._box);

        this._details = new DetailsMenu(this.menu);
        this._addPreferencesItem(extension);

        this._settingsIds = [
            ...METRICS.map(key => this._settings.connect(`changed::show-${key}`, () => this._rebuild())),
            this._settings.connect('changed::show-labels', () => this._rebuild()),
            this._settings.connect('changed::refresh-interval', () => this._restartTimer()),
        ];
        this._menuId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen)
                this._refresh();
        });

        this._rebuild();
        this._restartTimer();
    }

    _addPreferencesItem(extension) {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const item = new PopupMenu.PopupMenuItem(_('Settings'));
        item.connect('activate', () => extension.openPreferences());
        this.menu.addMenuItem(item);
    }

    _rebuild() {
        this._box.destroy_all_children();
        this._labels.clear();

        for (const key of METRICS) {
            if (!this._settings.get_boolean(`show-${key}`))
                continue;
            const label = new St.Label({
                style_class: 'panel-stats-value',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._box.add_child(label);
            this._labels.set(key, label);
        }

        this.visible = this._labels.size > 0;
        this._refresh();
    }

    _restartTimer() {
        if (this._timeoutId > 0)
            GLib.source_remove(this._timeoutId);

        const interval = Math.round(this._settings.get_double('refresh-interval') * 1000);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _sample() {
        return {
            cpu: this._cpu.read(),
            memory: readMemory(),
            net: this._net.read(),
            disk: this._disk.read(),
            system: readSystem(),
            temperature: this._temperature.read(),
        };
    }

    _text(key, data) {
        const prefix = this._settings.get_boolean('show-labels') ? `${PREFIXES[key]} ` : '';
        switch (key) {
        case 'cpu':
            return `${prefix}${percent(data.cpu.total)}`;
        case 'memory':
            return `${prefix}${percent(data.memory.usedPercent)}`;
        case 'network':
            return `${prefix}↓${shortRate(data.net.down)} ↑${shortRate(data.net.up)}`;
        case 'disk':
            return `${prefix}${percent(data.disk.usedPercent)}`;
        default:
            return data.temperature !== null ? `${prefix}${Math.round(data.temperature)}°C` : `${prefix}--`;
        }
    }

    _refresh() {
        const data = this._sample();
        for (const [key, label] of this._labels)
            label.set_text(this._text(key, data));
        if (this.menu.isOpen)
            this._details.update(data);
    }

    destroy() {
        if (this._timeoutId > 0) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._menuId > 0) {
            this.menu.disconnect(this._menuId);
            this._menuId = 0;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._settings = null;
        super.destroy();
    }
});

export default class PanelStatsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._placementIds = [
            this._settings.connect('changed::panel-position', () => this._place()),
            this._settings.connect('changed::panel-index', () => this._place()),
        ];
        this._place();
    }

    _place() {
        this._indicator?.destroy();
        this._indicator = new StatsIndicator(this);
        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-position'));
    }

    disable() {
        for (const id of this._placementIds ?? [])
            this._settings.disconnect(id);
        this._placementIds = [];
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
