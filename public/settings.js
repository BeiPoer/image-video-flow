export function bindSettings({ $, request, state, showToast, render, updateMode }) {
let settingsSaving = false;
let settingsOpening = false;
let settingsToken = '';
async function openSettings() {
  if (settingsOpening || settingsSaving) return;
  settingsOpening = true;
  try {
    const values = await request('/api/settings');
    const form = $('#settingsForm'); form.reset();
    settingsToken = values.settingsToken;
    for (const name of ['OPENAI_BASE_URL', 'OPENAI_IMAGE_MODEL', 'SEEDANCE_BASE_URL', 'SEEDANCE_MODEL', 'VIDEO_API_TYPE', 'PUBLIC_ASSET_BASE_URL']) form.elements[name].value = values[name];
    lastVideoType = values.VIDEO_API_TYPE || 'openai';
    $('#publicAssetBaseField').hidden = lastVideoType !== 'kyyReactApi' || state.cloudMediaEnabled;
    $('#publicAssetHelp').hidden = lastVideoType !== 'kyyReactApi' || state.cloudMediaEnabled;
    for (const [name, label] of [['OPENAI_API_KEY', '#openaiKeyState'], ['SEEDANCE_API_KEY', '#seedanceKeyState']]) {
      const configured = values[name + '_CONFIGURED'];
      form.elements[name].value = '';
      form.elements[name].placeholder = configured ? '********（已配置，留空保留）' : '尚未配置，请输入 API Key';
      $(label).textContent = configured ? '已配置' : '未配置';
      form.elements['CLEAR_' + name].disabled = !configured;
    }
    updateVideoApiHelp();
    $('#settingsError').hidden = true; $('#settingsDialog').showModal();
  } catch (err) { showToast(err.message); }
  finally { settingsOpening = false; }
}
async function saveSettings(event) {
  event.preventDefault();
  if (settingsSaving) return;
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  for (const name of ['CLEAR_OPENAI_API_KEY', 'CLEAR_SEEDANCE_API_KEY']) {
    values[name] = form.elements[name].checked;
    if (values[name]) values[name.replace('CLEAR_', '')] = '';
  }
  settingsSaving = true;
  const saveButton = $('#saveSettingsButton');
  saveButton.disabled = true;
  saveButton.textContent = '正在保存…';
  form.querySelectorAll('[data-close-settings]').forEach(button => { button.disabled = true; });
  $('#settingsError').hidden = true;
  try {
    const saved = await request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-settings-token': settingsToken }, body: JSON.stringify(values) });
    state.providers = { openai: saved.OPENAI_API_KEY_CONFIGURED ? 'configured' : 'demo', seedance: saved.SEEDANCE_API_KEY_CONFIGURED ? 'configured' : 'demo' };
    state.models = { openai: saved.OPENAI_IMAGE_MODEL, seedance: saved.SEEDANCE_MODEL };
    state.videoApiType = saved.VIDEO_API_TYPE;
    state.publicAssetBaseUrl = saved.PUBLIC_ASSET_BASE_URL;
    lastVideoType = saved.VIDEO_API_TYPE;
    $('#settingsDialog').close();
    render(); updateMode();
    showToast('模型配置已保存，新任务立即生效');
  } catch (err) {
    $('#settingsError').textContent = err.message;
    $('#settingsError').hidden = false;
  } finally {
    settingsSaving = false;
    saveButton.disabled = false;
    saveButton.textContent = '保存配置';
    form.querySelectorAll('[data-close-settings]').forEach(button => { button.disabled = false; });
  }
}
$('#settingsForm').addEventListener('submit', saveSettings);
$('#settingsDialog').addEventListener('cancel', (event) => { if (settingsSaving) event.preventDefault(); });
$('#settingsDialog').addEventListener('close', () => { $('#settingsForm').reset(); settingsToken = ''; });
document.querySelectorAll('[data-close-settings]').forEach(button => button.addEventListener('click', () => { if (!settingsSaving) $('#settingsDialog').close(); }));


const videoTypeLabels = { volcengine: '火山引擎官方（Ark）', openai: 'OpenAI Video（兼容接口）', kyyReactApi: 'kyyReactApi' };
const videoTypeDefaults = {
  volcengine: { base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedance-2-0-260128' },
  openai: { base: 'https://new.every-ai.cc/v1', model: 'doubao-seedance-2-0-mini-260615' },
  kyyReactApi: { base: 'https://zcbservice.aizfw.cn/kyyReactApiServer', model: 'sd_2.0_special' },
};
let lastVideoType = 'openai';
function updateVideoApiHelp() {
  const type = $('#videoApiType').value;
  const hints = {
    volcengine: '接口根地址示例：https://ark.cn-beijing.volces.com/api/v3；模型示例：doubao-seedance-2-0-260128。',
    openai: '默认接口根地址：https://new.every-ai.cc/v1；使用 /videos 接口。默认模型：doubao-seedance-2-0-mini-260615。多图和首尾帧需兼容服务商支持。',
    kyyReactApi: '接口根地址示例：https://zcbservice.aizfw.cn/kyyReactApiServer；模型示例：sd_2.0_special。可从素材库选择图片、视频和音频参考。',
  };
  $('#videoApiHelp').textContent = hints[type] + ' 切换类型不会改写地址、模型或密钥，请确认它们属于同一服务商。';
}
$('#videoApiType').addEventListener('change', () => {
  const nextType = $('#videoApiType').value;
  const previous = videoTypeDefaults[lastVideoType];
  const next = videoTypeDefaults[nextType];
  const base = $('#seedanceBaseUrl');
  const model = $('#seedanceModel');
  if (base.value === previous.base) base.value = next.base;
  if (model.value === previous.model) model.value = next.model;
  lastVideoType = nextType;
  updateVideoApiHelp();
  $('#publicAssetBaseField').hidden = nextType !== 'kyyReactApi' || state.cloudMediaEnabled;
  $('#publicAssetHelp').hidden = nextType !== 'kyyReactApi' || state.cloudMediaEnabled;
});

$('#settingsButton').addEventListener('click',openSettings);
}
