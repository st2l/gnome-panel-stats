import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/shell/extensions/prefs.js';

const PANEL_BOXES = [
    ['left', _('Left (next to Activities)')],
    ['center', _('Center (next to the clock)')],
    ['right', _('Right (next to Quick Settings)')],
];

function addSwitch(group, settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    group.add(row);
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
}

function addSpin(group, settings, key, title, subtitle, adjustment, digits) {
    const row = new Adw.SpinRow({title, subtitle, adjustment, digits});
    group.add(row);
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
}

function addPanelBoxRow(group, settings) {
    const row = new Adw.ComboRow({
        title: _('Panel box'),
        subtitle: _('Where the indicator is placed in the top bar'),
        model: Gtk.StringList.new(PANEL_BOXES.map(([, label]) => label)),
    });
    group.add(row);

    const keys = PANEL_BOXES.map(([key]) => key);
    row.selected = Math.max(keys.indexOf(settings.get_string('panel-position')), 0);
    row.connect('notify::selected', () => settings.set_string('panel-position', keys[row.selected]));
    settings.connect('changed::panel-position', () => {
        row.selected = Math.max(keys.indexOf(settings.get_string('panel-position')), 0);
    });
}

function buildVisibilityGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Panel items'),
        description: _('Choose which values are shown in the top bar'),
    });
    addSwitch(group, settings, 'show-cpu', _('CPU load'), _('Total processor load in percent'));
    addSwitch(group, settings, 'show-memory', _('Memory usage'), _('Used RAM in percent'));
    addSwitch(group, settings, 'show-network', _('Network speed'), _('Download and upload rate'));
    addSwitch(group, settings, 'show-disk', _('Disk usage'), _('Used space of the root filesystem'));
    addSwitch(group, settings, 'show-temperature', _('CPU temperature'), _('Reported by hwmon or thermal zones'));
    addSwitch(group, settings, 'show-labels', _('Text labels'), _('Prefix each value with CPU, RAM, NET …'));
    return group;
}

function buildPlacementGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Placement and refresh'),
    });
    addPanelBoxRow(group, settings);
    addSpin(group, settings, 'panel-index', _('Position inside the box'),
        _('0 is the leftmost slot, 1 sits right after the Activities button'),
        new Gtk.Adjustment({lower: 0, upper: 20, step_increment: 1, page_increment: 1}), 0);
    addSpin(group, settings, 'refresh-interval', _('Refresh interval'),
        _('Seconds between two samples'),
        new Gtk.Adjustment({lower: 0.5, upper: 30, step_increment: 0.5, page_increment: 1}), 1);
    return group;
}

export default class PanelStatsPreferences extends ExtensionPreferences {
    /**
     * Builds the preferences window contents.
     *
     * @param {Adw.PreferencesWindow} window - window to fill
     */
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: _('Panel Stats'),
            icon_name: 'utilities-system-monitor-symbolic',
        });
        page.add(buildVisibilityGroup(settings));
        page.add(buildPlacementGroup(settings));
        window.add(page);
    }
}
