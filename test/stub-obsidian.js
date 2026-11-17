/* Minimal 'obsidian' stub so the pure logic modules can be bundled & run in
 * plain Node for tests. Only members referenced at module-load time matter. */
class Dummy {}
module.exports = {
  requestUrl: async () => ({ status: 200, text: "{}" }),
  MarkdownRenderer: { render: async () => {} },
  Component: Dummy,
  ItemView: Dummy,
  Plugin: Dummy,
  PluginSettingTab: Dummy,
  Setting: Dummy,
  Notice: Dummy,
  MarkdownView: Dummy,
  Menu: Dummy,
  Editor: Dummy,
  TFile: Dummy,
  normalizePath: (s) => s,
};
