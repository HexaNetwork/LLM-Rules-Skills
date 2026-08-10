/** Browser JS fragment inlined by renderDashboard (Phase 4). */
export const renderSettingsScript = `    function renderSettings(settings) {
      var definitions = Array.isArray(settings.definitions) ? settings.definitions : [];
      var values = settings.values || {};
      var categories = [];
      definitions.forEach(function (definition) {
        if (definition.key === 'git.ignoredArtifactPatterns') return;
        var category = definition.category || "General";
        var group = categories.find(function (candidate) { return candidate.name === category; });
        if (!group) { group = { name:category, definitions:[] }; categories.push(group); }
        group.definitions.push(definition);
      });
      var fields = categories.map(function (category) {
        var rows = category.definitions.map(function (definition) {
          var id = "setting-" + String(definition.key).replace(/[^a-z0-9_-]/gi,"-");
          var input;
          if (definition.type === "boolean") {
            input = '<input id="' + attr(id) + '" data-setting-key="' + attr(definition.key) + '" data-setting-type="boolean" type="checkbox"' + (values[definition.key] ? ' checked' : '') + (settings.editable ? '' : ' disabled') + '>';
          } else if (definition.type === "enum") {
            var options = Array.isArray(definition.options) ? definition.options : [];
            var optionHtml = options.map(function (option) {
              return '<option value="' + attr(option.value) + '"' + (values[definition.key] === option.value ? ' selected' : '') + '>' + esc(option.label) + '</option>';
            }).join('');
            input = '<select id="' + attr(id) + '" data-setting-key="' + attr(definition.key) + '" data-setting-type="enum"' + (settings.editable ? '' : ' disabled') + '>' + optionHtml + '</select>';
          } else if (definition.type === "string-list") {
            var lines = Array.isArray(values[definition.key]) ? values[definition.key].join('\\n') : '';
            input = '<textarea id="' + attr(id) + '" data-setting-key="' + attr(definition.key) + '" data-setting-type="string-list" rows="6" maxlength="' + attr(definition.maximumItems * (definition.maximumItemLength + 1)) + '"' + (settings.editable ? '' : ' disabled') + '>' + esc(lines) + '</textarea>' +
              (definition.key === 'workflow.testPathPatterns' ? '<div style="margin-top:8px"><button type="button" class="btn small" data-open-test-folder-picker="true"' + (settings.editable ? '' : ' disabled') + '>Select repository folder…</button></div><div id="testFolderPicker" class="folder-picker" hidden></div>' : '');
          } else if (definition.type === "string") {
            input = '<input id="' + attr(id) + '" data-setting-key="' + attr(definition.key) + '" data-setting-type="string" type="text" value="' + attr(values[definition.key] || '') + '" maxlength="' + attr(definition.maximum) + '" required' + (settings.editable ? '' : ' disabled') + '>';
          } else {
            input = '<input id="' + attr(id) + '" data-setting-key="' + attr(definition.key) + '" data-setting-type="integer" type="number" value="' + attr(values[definition.key]) + '" min="' + attr(definition.minimum) + '" max="' + attr(definition.maximum) + '" step="1" required' + (settings.editable ? '' : ' disabled') + '>';
          }
          var applies = 'Applies to new runs; blocked runs require an explicit reviewed amendment';
          return '<label class="setting-row" for="' + attr(id) + '"><span><strong>' + esc(definition.label) + '</strong><span class="faint">' + esc(definition.description) + '</span><span class="faint" style="display:block;margin-top:4px">' + esc(applies) + '</span></span>' + input + '</label>';
        }).join('');
        return '<section class="settings-group"><h3>' + esc(category.name) + '</h3>' + rows + '</section>';
      }).join('');
      var persistence = settings.editable
        ? 'Settings apply to new runs. Blocked runs require an explicit reviewed amendment.'
        : 'This dashboard was started without a config file path, so settings are read-only.';
      var grillLayout = getGrillOptionsLayout();
      var displayGroup = '<section class="settings-group"><h3>Display</h3>' +
        '<label class="setting-row" for="grill-options-layout"><span><strong>Grill options layout</strong><span class="faint">Arrange recommended options as columns or stacked rows</span></span>' +
        '<select id="grill-options-layout">' +
          '<option value="columns"' + (grillLayout === "columns" ? ' selected' : '') + '>Columns</option>' +
          '<option value="rows"' + (grillLayout === "rows" ? ' selected' : '') + '>Rows</option>' +
        '</select></label></section>';
      var artifactPatterns = Array.isArray(values["git.ignoredArtifactPatterns"]) ? values["git.ignoredArtifactPatterns"] : [];
      var artifactRows = artifactPatterns.length
        ? artifactPatterns.map(function (pattern, index) {
            return '<div class="setting-row" style="align-items:center"><code style="font-size:12px;word-break:break-all">' + esc(pattern) + '</code>' +
              (settings.editable
                ? '<button type="button" class="btn small danger" data-remove-artifact-index="' + attr(String(index)) + '">Remove</button>'
                : '') +
              '</div>';
          }).join('')
        : '<div class="muted">No ignored artifact patterns yet.</div>';
      var artifactGroup = '<section class="settings-group" id="ignoredArtifactsGroup"><h3>Ignored build artifacts</h3>' +
        '<p class="faint" style="margin:0 0 8px">Harness-local globs skipped for dirty-tree and unreported-path checks. Does not edit .gitignore; amend blocked runs explicitly when needed.</p>' +
        '<div id="ignoredArtifactsList" style="display:grid;gap:8px">' + artifactRows + '</div></section>';
      $("settingsBody").innerHTML = '<p class="settings-intro">Tune workflow behavior from one place. Settings freeze into new runs; blocked runs can be amended through an explicit reviewed recovery action.</p>' + fields + artifactGroup + displayGroup;
      $("settingsScope").textContent = persistence;
      $("saveSettingsBtn").disabled = !settings.editable;
      var layoutSelect = $("grill-options-layout");
      if (layoutSelect) {
        layoutSelect.addEventListener("change", function () {
          setGrillOptionsLayout(layoutSelect.value);
          applyGrillOptionsLayout();
        });
      }
    }

    async function openSettings() {
      try {
        var data = await api('/api/settings');
        state.settings = data.settings;
        renderSettings(state.settings);
        $("settingsDialog").showModal();
      } catch (error) { toast(error.message,true); }
    }

    async function removeIgnoredArtifact(index) {
      if (!state.settings || !state.settings.editable) return;
      var current = Array.isArray(state.settings.values["git.ignoredArtifactPatterns"])
        ? state.settings.values["git.ignoredArtifactPatterns"].slice()
        : [];
      if (index < 0 || index >= current.length) return;
      current.splice(index, 1);
      try {
        var values = collectSettingsValues();
        values["git.ignoredArtifactPatterns"] = current;
        var data = await api('/api/settings', { method: 'PUT', body: { values: values } });
        state.settings = data.settings;
        if (state.bootstrap) state.bootstrap.project.settings = data.settings;
        renderSettings(state.settings);
        toast('Ignored artifact pattern removed');
      } catch (error) { toast(error.message, true); }
    }

    function testPatternInput() {
      return $("setting-workflow-testPathPatterns");
    }

    async function openTestFolderPicker(relativePath) {
      try {
        var data = await api('/api/repository/folders?path=' + encodeURIComponent(relativePath || ''));
        var panel = $("testFolderPicker");
        if (!panel) return;
        var currentPath = data.path || '';
        var label = currentPath || 'repository root';
        var parent = data.parent;
        var navigation = (parent !== undefined ? '<button type="button" class="btn small" data-test-folder-path="' + attr(parent) + '">← Parent</button>' : '') +
          (currentPath ? '<button type="button" class="btn small primary" data-use-test-folder="' + attr(currentPath) + '">Use this folder</button>' : '');
        var folders = Array.isArray(data.folders) ? data.folders : [];
        var children = folders.length ? folders.map(function (name) {
          var childPath = currentPath ? currentPath + '/' + name : name;
          return '<div class="folder-picker-item"><code>' + esc(name) + '/</code><button type="button" class="btn small" data-test-folder-path="' + attr(childPath) + '">Open</button></div>';
        }).join('') : '<div class="faint">No subfolders.</div>';
        panel.innerHTML = '<div class="faint">Choose a folder under <code>' + esc(label) + '</code>; it will add <code>' + esc(currentPath ? currentPath + '/**' : '**') + '</code>.</div><div style="display:flex;gap:8px;margin-top:10px">' + navigation + '<button type="button" class="btn small" data-close-test-folder-picker="true">Cancel</button></div><div class="folder-picker-list">' + children + '</div>';
        panel.hidden = false;
      } catch (error) { toast(error.message, true); }
    }

    function useTestFolder(relativePath) {
      var input = testPatternInput();
      if (!input || !relativePath) return;
      var pattern = relativePath.replaceAll('\\\\', '/') + '/**';
      var patterns = input.value.split(/\\r?\\n/).map(function (line) { return line.trim(); }).filter(Boolean);
      if (!patterns.includes(pattern)) patterns.push(pattern);
      input.value = patterns.join('\\n');
      var panel = $("testFolderPicker");
      if (panel) panel.hidden = true;
    }

    function collectSettingsValues() {
      var values = {};
      $("settingsForm").querySelectorAll('[data-setting-key]').forEach(function (input) {
        var type = input.dataset.settingType;
        values[input.dataset.settingKey] = type === 'integer' ? Number(input.value) : (type === 'boolean' ? input.checked : (type === 'string-list' ? input.value.split(/\\r?\\n/).map(function (line) { return line.trim(); }).filter(Boolean) : input.value));
      });
      var patterns = (state.settings && state.settings.values && state.settings.values["git.ignoredArtifactPatterns"]) || [];
      values["git.ignoredArtifactPatterns"] = Array.isArray(patterns) ? patterns.slice() : [];
      return values;
    }
`;
