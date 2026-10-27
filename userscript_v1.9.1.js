// ==UserScript==
// @name         站点密码填充器
// @namespace    https://github.com/yourname
// @version      1.9.1
// @description  协议+端口级账号；分列管理面板；持久选择器；
// @author       NightGlow
// @match        https://*/*
// @match        http://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @require      https://cdn.jsdelivr.net/npm/crypto-js@4.1.1/crypto-js.js
// ==/UserScript==

(() => {
    'use strict';
    const MASTER_KEY = GM_getValue('masterKey', 'defaultSaltChangeMe');
    const TRIGGER_KEY = 'F';

    /* ===== 站点 key ===== */
    const siteKey = () => {
        const p = location.protocol.toLowerCase();
        const port = location.port || (p === 'https:' ? '443' : '80');
        const portShow = (p === 'https:' && port === '443') || (p === 'http:' && port === '80')
        ? ''
        : ':' + port;
        return `${p}//${location.hostname}${portShow}`;
    };

    /* ===== 工具 ===== */
    const encrypt = txt => CryptoJS.AES.encrypt(txt, MASTER_KEY).toString();
    const decrypt = txt => CryptoJS.AES.decrypt(txt, MASTER_KEY).toString(CryptoJS.enc.Utf8);

    const getAccounts = k => JSON.parse(GM_getValue(`accounts_${k}`, '[]'));
    const setAccounts = (k, list) => list.length ? GM_setValue(`accounts_${k}`, JSON.stringify(list)) : GM_deleteValue(`accounts_${k}`);
    const getSelectors = () => JSON.parse(GM_getValue(`selectors_${siteKey()}`, '{}'));
    const setSelectors = obj => GM_setValue(`selectors_${siteKey()}`, JSON.stringify(obj));

    /* ===== 通用 DOM 查询 ===== */
    function deepQuery(selector, root = document) {
        const arr = Array.from(root.querySelectorAll(selector));
        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) arr.push(...deepQuery(selector, el.shadowRoot));
        });
        root.querySelectorAll('iframe').forEach(f => {
            try { if (f.contentDocument) arr.push(...deepQuery(selector, f.contentDocument)); } catch {}
        });
        return arr;
    }

    /* ===== 探测用户名/密码框 ===== */
    function findUserField() {
        const selList = [
            'input[type=text][name*=user i]', 'input[type=text][name*=login i]', 'input[type=email]',
            'input[autocomplete=username]', 'input[placeholder*=user i]', 'input[placeholder*=邮箱 i]'
        ];
        for (const s of selList) {
            const el = deepQuery(s)[0];
            if (el) return el;
        }
        return deepQuery('input[type=text]').find(el => el.offsetWidth > 0);
    }

    function findPwdField() {
        let pwd = deepQuery('input[type=password]')[0];
        if (pwd) return pwd;
        return deepQuery('input').find(el => getComputedStyle(el).webkitTextSecurity === 'disc');
    }

    /* ===== 智能等待 ===== */
    async function waitFields() {
        return new Promise(resolve => {
            const tryGet = () => {
                const user = findUserField();
                const pwd = findPwdField();
                if (user && pwd) return resolve({ userField: user, pwdField: pwd });
            };
            if (tryGet()) return;

            const ob = new MutationObserver(() => {
                if (tryGet()) { ob.disconnect(); resolve({ userField: findUserField(), pwdField: findPwdField() }); }
            });
            ob.observe(document, { childList: true, subtree: true });
            setTimeout(() => { ob.disconnect(); resolve({}); }, 5000);
        });
    }

    /* =========================================================
     * 完全模拟人类输入
     * el   : 需要填充的 <input> 或 <textarea> 元素
     * text : 需要填充的字符串
     * =========================================================*/
    function nativeFill(el, text) {
        if (!el) return;

        /* 1. 获得焦点并点击，确保光标在框内 */
        el.focus?.();
        el.click?.();

        /* 2. 清空旧内容 */
        el.select?.();
        el.setRangeText('', 0, el.value.length, 'end');

        /* 3. 逐字符模拟键盘输入 */
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];

            /* keydown */
            el.dispatchEvent(
                new KeyboardEvent('keydown', {
                    bubbles: true,
                    cancelable: true,
                    key: ch,
                    code: `Key${ch.toUpperCase()}`,
                    which: ch.charCodeAt(0),
                    keyCode: ch.charCodeAt(0),
                })
            );

            /* keypress（兼容旧站点） */
            el.dispatchEvent(
                new KeyboardEvent('keypress', {
                    bubbles: true,
                    cancelable: true,
                    key: ch,
                    code: `Key${ch.toUpperCase()}`,
                    which: ch.charCodeAt(0),
                    keyCode: ch.charCodeAt(0),
                })
            );

            /* 插入字符并触发 input */
            el.setRangeText(ch, el.selectionStart, el.selectionStart, 'end');
            el.dispatchEvent(
                new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    inputType: 'insertText',
                    data: ch,
                })
            );

            /* keyup */
            el.dispatchEvent(
                new KeyboardEvent('keyup', {
                    bubbles: true,
                    cancelable: true,
                    key: ch,
                    code: `Key${ch.toUpperCase()}`,
                    which: ch.charCodeAt(0),
                    keyCode: ch.charCodeAt(0),
                })
            );
        }

        /* 4. React/Vue 等框架在 blur 时才 flush 值，故主动 blur */
        el.blur?.();

        /* 5. React 16+ 额外需要 change 事件 */
        el.dispatchEvent?.(new Event('change', { bubbles: true }));
    }

    /* ===== 智能填充主逻辑 ===== */
        async function fill() {
            const { userField, pwdField } = await waitFields();
            if (!userField || !pwdField) return;

            const cur = getAccounts(siteKey());
            const cred = cur.find(a => a.isDefault) || cur[0];
            if (!cred) return;

            nativeFill(userField, cred.user);
            nativeFill(pwdField, decrypt(cred.pass));
            console.log(userField,pwdField)
        }

    /* ===== 管理面板 ===== */
    function openManagePanel(mode = 'normal') {
        if (document.getElementById('tm-manage-panel')) return;

        const all = {};
        GM_listValues().filter(k => k.startsWith('accounts_')).forEach(k => all[k.replace('accounts_', '')] = getAccounts(k.replace('accounts_', '')));
        const cur = getAccounts(siteKey());
        const curDefault = cur.find(a => a.isDefault);

        const panel = document.createElement('div');
        panel.id = 'tm-manage-panel';
        panel.innerHTML = `
      <style>
        #tm-manage-panel{position:fixed;top:5%;left:5%;width:90%;height:90%;background:#fff;border:1px solid #ccc;border-radius:8px;z-index:99999;font-family:Arial;font-size:14px;display:flex;flex-direction:column;box-shadow:0 0 10px rgba(0,0,0,.3);}
        #tm-manage-panel header{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#007acc;color:#fff;border-radius:8px 8px 1px 1px;}
        #tm-manage-panel .close{cursor:pointer;font-size:18px;}
        #tm-manage-panel .content{display:flex;flex:1;min-height:0;}
        #tm-manage-panel .left,#tm-manage-panel .right{flex:1;padding:10px;overflow-y:auto;}
        #tm-manage-panel .left{border-right:1px solid #ddd;}
        #tm-manage-panel ul{margin:0;padding:0;list-style:none;}
        #tm-manage-panel li{margin:4px 0;display:flex;justify-content:space-between;align-items:center;}
        #tm-manage-panel strong{color:red;}
        #tm-manage-panel input{background:#e0e0e0;color:#c22727;outline:none;border:0;border-radius:3px;padding:4px 8px;width:calc(100% - 90px);padding:4px;margin:4px 0;}
        #tm-manage-panel button{background:transparent;color:#c22727;border:1px solid #007acc;border-radius:3px;padding:4px 8px;margin-left:4px;}
        .site-item{background:rgb(235,235,235);border-radius:4px;padding:6px 8px;margin-bottom:6px;line-height:1.4;}
        .site-name{font-weight:bold;color:#333;}
        .site-users{color:#555;font-size:13px;}
        #cur-list li{background:rgb(240,240,240);}
        #cur-list li span:first-of-type{color:#007acc;}
      </style>
      <header>
        <span>账号管理面板</span>
        <span class="close" onclick="this.parentNode.parentNode.remove()">✕</span>
      </header>
      <div class="content">
        <div class="left">
          <strong>全部站点账号</strong>
          <ul id="all-list"></ul>
        </div>
        <div class="right">
          <strong>当前：${siteKey()}</strong>
          <div id="auto-fill-status" style="margin-bottom:6px;color:#007acc;"></div>
          <ul id="cur-list"></ul>
          <div>
            <input id="new-user" placeholder="用户名" />
            <input id="new-pwd"  placeholder="密码" />
            <button id="add-btn">新增</button>
          </div>
          <div style="margin-top:8px;">
            <button id="export-btn">导出</button>
            <button id="import-btn">导入</button>
            <button id="clear-btn">清空全部</button>
            <button id="selector-btn">手动指定选择器</button>
          </div>
        </div>
      </div>
    `;
        document.body.appendChild(panel);

        /* 左侧：站点 + 账号（栅栏样式，一行站点一行账号） */
        const allUL = panel.querySelector('#all-list');
        allUL.innerHTML = '';

        GM_listValues().filter(k => k.startsWith('accounts_')).forEach(k => all[k.replace('accounts_', '')] = getAccounts(k.replace('accounts_', '')));
        Object.keys(all).sort().forEach(addr => {
            const list = getAccounts(addr);
            const block = document.createElement('div');
            block.className = 'site-item';
            block.style.cssText = 'background:rgb(235,235,235);border-radius:4px;padding:6px 8px;margin-bottom:6px;line-height:1.4;';
            const name = document.createElement('div');
            name.className = 'site-name';
            name.textContent = addr;
            name.style.cssText = 'font-weight:bold;color:#333;margin-bottom:2px;';
            const users = document.createElement('div');
            users.className = 'site-users';
            users.textContent = list.map(a => (a.isDefault ? '✅' : '') + a.user).join(', ');
            users.style.cssText = 'font-size:13px;color:#555;';
            block.appendChild(name);
            block.appendChild(users);
            allUL.appendChild(block);
        });

        /* 右侧：当前站点账号 + 改密码/设默认 */
        const curUL = panel.querySelector('#cur-list');
        const autoStatusDiv = panel.querySelector('#auto-fill-status');
        autoStatusDiv.textContent = inWhiteList() ? '✅ 已加入自动填充白名单' : '⚠️ 未加入自动填充白名单';

        const renderCur = () => {
            curUL.innerHTML = '';
            const list = getAccounts(siteKey());
            list.forEach((acc, i) => {
                const li = document.createElement('li');
                li.innerHTML = `
          <span>${acc.user} ${acc.isDefault ? '(默认)' : ''}</span>
          <div>
            <button data-pwd="${i}">改密码</button>
            <button data-default="${i}">${acc.isDefault ? '取消默认' : '设为默认'}</button>
            <button data-del="${i}">删除</button>
          </div>
        `;
                curUL.appendChild(li);
            });
            curUL.querySelectorAll('[data-pwd]').forEach(btn =>
                                                         btn.onclick = () => {
                const list = getAccounts(siteKey());
                const item = list[btn.dataset.pwd];
                const newPwd = prompt('新密码（不填取消）');
                if (!newPwd) return;
                item.pass = encrypt(newPwd);
                setAccounts(siteKey(), list);
                alert('密码已更新');
                renderCur();
            }
                                                        );
            curUL.querySelectorAll('[data-default]').forEach(btn =>
                                                             btn.onclick = () => {
                const list = getAccounts(siteKey());
                list.forEach(a => a.isDefault = false);
                list[btn.dataset.default].isDefault = true;
                setAccounts(siteKey(), list);
                renderCur();
            }
                                                            );
            curUL.querySelectorAll('[data-del]').forEach(btn =>
                                                         btn.onclick = () => {
                const list = getAccounts(siteKey());
                list.splice(btn.dataset.del, 1);
                setAccounts(siteKey(), list);
                renderCur();
            }
                                                        );
        };
        renderCur();

        /* 新增账号 / 其余按钮 */
        panel.querySelector('#add-btn').onclick = () => {
            const u = panel.querySelector('#new-user').value.trim();
            const p = panel.querySelector('#new-pwd').value.trim();
            if (!u || !p) return alert('不能为空');
            const list = getAccounts(siteKey());
            list.forEach(a => a.isDefault = false);
            list.push({ user: u, pass: encrypt(p), isDefault: true });
            setAccounts(siteKey(), list);
            panel.querySelector('#new-user').value = '';
            panel.querySelector('#new-pwd').value = '';
            renderCur();
        };
        panel.querySelector('#export-btn').onclick = () => {
            const data = { accounts: {}, selectors: {} };
            GM_listValues().filter(k => k.startsWith('accounts_')).forEach(k => data.accounts[k] = GM_getValue(k));
            GM_listValues().filter(k => k.startsWith('selectors_')).forEach(k => data.selectors[k] = GM_getValue(k));
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'site_accounts.json';
            a.click();
        };
        panel.querySelector('#import-btn').onclick = () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = e => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    try {
                        const { accounts, selectors } = JSON.parse(reader.result);
                        Object.entries(accounts || {}).forEach(([k, v]) => GM_setValue(k, v));
                        Object.entries(selectors || {}).forEach(([k, v]) => GM_setValue(k, v));
                        alert('导入完成！');
                        openManagePanel(); // 刷新
                    } catch { alert('文件格式错误'); }
                };
                reader.readAsText(file);
            };
            input.click();
        };
        panel.querySelector('#clear-btn').onclick = () => {
            if (confirm('确定清空全部数据？不可撤销！')) {
                GM_listValues().filter(k => k.startsWith('accounts_') || k.startsWith('selectors_') || k === 'whiteList').forEach(k => GM_deleteValue(k));
                alert('已全部清空！');
                openManagePanel();
            }
        };
        panel.querySelector('#selector-btn').onclick = () => {
            const s = getSelectors();
            const uSel = prompt('用户名选择器', s.user || '');
            const pSel = prompt('密码选择器', s.pwd || '');
            if (uSel !== null || pSel !== null) {
                setSelectors({ user: uSel || '', pwd: pSel || '' });
                alert('选择器已保存！');
            }
        };
    }

    /* ========== 白名单 & 菜单 ========== */
    const getWhiteList = () => JSON.parse(GM_getValue('whiteList', '[]'));
    const inWhiteList = () => getWhiteList().includes(siteKey());
    function toggleWhiteList() {
        const list = getWhiteList();
        const key = siteKey();
        if (list.includes(key)) {
            GM.setValue('whiteList', JSON.stringify(list.filter(k => k !== key)));
            alert(`已取消 ${key} 自动填充`);
        } else {
            list.push(key);
            GM.setValue('whiteList', JSON.stringify(list));
            alert(`已将 ${key} 加入自动填充`);
        }
    }

    // GM_registerMenuCommand('手动填充账号密码', () => fill());
    GM_registerMenuCommand('手动填充账号密码', () => {
        const accs = getAccounts(siteKey());
        if (!accs || accs.length === 0) {
            alert('当前站点未保存账号密码');
            return;
        }
        fill();
    });
    GM_registerMenuCommand('添加/移除自动填充白名单', toggleWhiteList);
    GM_registerMenuCommand('账号管理面板', openManagePanel);

    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === TRIGGER_KEY) {
            e.preventDefault();
            // 判断本地是否保存了当前站点账号
            const accs = getAccounts(siteKey());
            if (!accs || accs.length === 0) {
                alert('当前站点未保存账号密码');
                return;
            }
            fill();
        }
    });

    if (inWhiteList()) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => fill());
        else fill();
    }
})();
