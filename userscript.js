// ==UserScript==
// @name         密码填充器
// @namespace    https://github.com/NightGlow954/WebPasswordFiller
// @version      2.0.0
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

    /* ===== 主密钥（必填，首次运行引导）===== */
    let MASTER_KEY = null;
    const TRIGGER_KEY = 'F';

    function ensureMasterKey() {
        const stored = GM_getValue('masterKey', null);
        if (stored) {
            MASTER_KEY = stored;
            return;
        }
        // 首次运行：检测是否已有旧加密数据
        const hasOldData = GM_listValues().some(k => k.startsWith('accounts_'));
        if (hasOldData) {
            alert(
                '检测到您已有旧版加密账号数据。\n\n' +
                '更换主密钥前，请先点击“账号管理面板” → “导出”备份明文 JSON，\n' +
                '再在此设置新主密钥，最后使用“导入”恢复数据。\n\n' +
                '旧密文在更换主密钥后将无法解密。'
            );
        }
        const input = prompt('请设置主密钥（用于加密本地账号密码，不可找回）：');
        if (!input || input.trim() === '') {
            alert('主密钥不能为空。本次会话将使用临时密钥，刷新后账号数据将丢失。');
            MASTER_KEY = 'temp_' + Math.random().toString(36).slice(2);
        } else {
            MASTER_KEY = input.trim();
            GM_setValue('masterKey', MASTER_KEY);
        }
    }

    ensureMasterKey();

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
    const deepQuery = (selector, root = document) => {
        const arr = Array.from(root.querySelectorAll(selector));
        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) arr.push(...deepQuery(selector, el.shadowRoot));
        });
        root.querySelectorAll('iframe').forEach(f => {
            try { if (f.contentDocument) arr.push(...deepQuery(selector, f.contentDocument)); } catch {}
        });
        return arr;
    };

    /* ===== 探测用户名/密码框 ===== */
    const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

    const findUserField = () => {
        const selList = [
            'input#username', 'input.username',
            'input[id*=user i]', 'input[name*=user i]',
            'input[type=text][name*=user i]', 'input[type=text][name*=login i]',
            'input[type=email]',
            'input[autocomplete=username]',
            'input[placeholder*=user i]', 'input[placeholder*=邮箱 i]'
        ];
        /* 1. 先尝试内置默认选择器 */
        for (const s of selList) {
            const el = deepQuery(s).find(isVisible);
            if (el) return el;
        }
        /* 2. 默认失败，再尝试用户手动指定的选择器（兜底） */
        const custom = getSelectors().user;
        if (custom) {
            const el = deepQuery(custom).find(isVisible);
            if (el) return el;
        }
        /* 3. 最后兜底：任意可见文本框 */
        return deepQuery('input[type=text]').find(isVisible);
    };

    const findPwdField = () => {
        /* 1. 先尝试内置默认选择器 */
        const pwd = deepQuery('input[type=password]').find(isVisible);
        if (pwd) return pwd;
        const disc = deepQuery('input').find(el => isVisible(el) && getComputedStyle(el).webkitTextSecurity === 'disc');
        if (disc) return disc;
        /* 2. 默认失败，再尝试用户手动指定的选择器（兜底） */
        const custom = getSelectors().pwd;
        if (custom) {
            const el = deepQuery(custom).find(isVisible);
            if (el) return el;
        }
        return null;
    };

    /* ===== 智能等待 ===== */
    const waitFields = async () => {
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
            /* SPA/动态表单可能延迟出现，最多等待 15 秒 */
            setTimeout(() => { ob.disconnect(); resolve({}); }, 15000);
        });
    };

    /* =========================================================
     * 稳健填充：赋值并触发框架所需事件
     * el   : 需要填充的 <input> 或 <textarea> 元素
     * text : 需要填充的字符串
     * =========================================================*/
    const nativeFill = (el, text) => {
        if (!el) return;

        try {
            el.focus?.();
            el.click?.();

            /* 清空并赋值 */
            el.value = text;

            /* 触发框架（React/Vue/Angular）需要的事件 */
            el.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: text,
            }));
            el.dispatchEvent(new Event('change', { bubbles: true }));

            el.blur?.();
        } catch (e) {
            console.warn('[auto-fill] nativeFill failed:', e);
        }
    };

    /* ===== 智能填充主逻辑 ===== */
        const fill = async () => {
            const status = document.getElementById('auto-fill-status');
            const setStatus = (text, cls) => {
                if (status) { status.textContent = text; status.className = cls; }
            };
            try {
                const { userField, pwdField } = await waitFields();
                const cur = getAccounts(siteKey());
                const cred = cur.find(a => a.isDefault) || cur[0];
                if (!cred) {
                    setStatus('⚠️ 未找到账号', 'warn');
                    return;
                }
                setStatus('🔄 填充中…', 'ok');

                let ok = true;
                try {
                    if (userField) nativeFill(userField, cred.user);
                } catch (e) {
                    console.warn('[auto-fill] user fill failed:', e);
                    setStatus('⚠️ 用户名填充失败', 'warn');
                    ok = false;
                }

                try {
                    if (pwdField) nativeFill(pwdField, decrypt(cred.pass));
                } catch (e) {
                    console.warn('[auto-fill] pwd fill failed:', e);
                    setStatus('⚠️ 密码填充失败', 'warn');
                    ok = false;
                }

                if (ok && userField && pwdField) {
                    setStatus('✅ 填充完成', 'ok');
                }
            } catch (e) {
                console.warn('[auto-fill] fill error:', e);
                setStatus('❌ 填充异常', 'warn');
            }
        };

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
        /* 扫描线动画 */
        @keyframes scanline {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100%); }
        }
        @keyframes pulse {
          0%, 100% { box-shadow: 0 0 5px #00f2ff, 0 0 10px #00f2ff; }
          50% { box-shadow: 0 0 20px #00f2ff, 0 0 30px #00f2ff, 0 0 40px #00f2ff; }
        }
        #tm-manage-panel{
          position:fixed;top:3%;left:3%;width:94%;height:94%;
          background: radial-gradient(circle at top left, #3a3a4e, #2a2a3e);
          border:1px solid #00f2ff;
          border-radius:12px;
          z-index:999999;
          font-family:'Courier New',Consolas,monospace;
          font-size:13px;
          color:#e0e0ff;
          display:flex;flex-direction:column;
          box-shadow:0 0 30px rgba(0,242,255,.15);
          overflow:hidden;
        }
        #tm-manage-panel::before{
          content:"";position:absolute;top:0;left:0;width:100%;height:2px;
          background:linear-gradient(90deg, transparent, #00f2ff, #00a8ff, #00f2ff, transparent);
          animation: scanline 3s linear infinite;
        }
        #tm-manage-panel header{
          display:flex;justify-content:space-between;align-items:center;
          padding:10px 16px;
          background:linear-gradient(90deg, #3a3a4e, #2a2a3e);
          color:#00f2ff;
          border-bottom:1px solid #00f2ff;
          font-weight:bold;
          letter-spacing:2px;
          text-transform:uppercase;
        }
        #tm-manage-panel header .title{display:flex;align-items:center;gap:8px;}
        #tm-manage-panel header .title::before{content:"[ SYS ]";color:#00f2ff;margin-right:6px;font-size:11px;}
        #tm-manage-panel .close{cursor:pointer;font-size:20px;color:#00f2ff;text-shadow:0 0 8px #00f2ff;}
        #tm-manage-panel .close:hover{color:#fff;}
        #tm-manage-panel .content{display:flex;flex:1;min-height:0;overflow:hidden;}
        #tm-manage-panel .left,#tm-manage-panel .right{flex:1;padding:16px;overflow-y:auto;}
        #tm-manage-panel .left{border-right:1px solid #2a2a3e;}
        #tm-manage-panel ul{margin:0;padding:0;list-style:none;}
        #tm-manage-panel li{
          margin:8px 0;
          display:flex;justify-content:space-between;align-items:center;
          background:rgba(0,242,255,.04);
          border:1px solid rgba(0,242,255,.15);
          border-radius:8px;
          padding:8px 12px;
          transition:all .2s;
        }
        #tm-manage-panel li:hover{
          border-color:#00f2ff;
          background:rgba(0,242,255,.1);
          box-shadow:0 0 15px rgba(0,242,255,.1);
        }
        #tm-manage-panel strong{color:#00f2ff;display:block;margin-bottom:10px;font-size:14px;letter-spacing:1px;}
        #tm-manage-panel input{
          background:transparent;
          color:#00f2ff;
          outline:none;border:1px solid #00f2ff;
          border-radius:4px;padding:4px 8px;width:40%;box-sizing:border-box;margin:2px 4px 2px 0;
        }
        #tm-manage-panel input::placeholder{color:#00f2ff;}
        #tm-manage-panel button{
          background:transparent;
          color:#00f2ff;
          border:1px solid #00f2ff;
          border-radius:4px;
          padding:6px 12px;
          margin:2px 4px;
          cursor:pointer;
          font-family:inherit;
          transition:all .2s;
        }
        #tm-manage-panel button:hover{
          background:#00f2ff;
          color:#000;
          box-shadow:0 0 15px #00f2ff;
        }
        #tm-manage-panel button.danger{border-color:#ff0055;color:#ff0055;}
        #tm-manage-panel button.danger:hover{background:#ff0055;color:#fff;box-shadow:0 0 15px #ff0055;}
        #tm-manage-panel button.ghost{border-color:#4a4a6a;color:#aaa;}
        #tm-manage-panel button.ghost:hover{border-color:#00f2ff;color:#fff;text-shadow:0 0 8px #00f2ff;}
        .site-item{background:rgba(0,242,255,.05);border-radius:8px;padding:10px;margin-bottom:10px;line-height:1.5;border:1px solid rgba(0,242,255,.2);}
        .site-name{font-weight:bold;color:#00f2ff;margin-bottom:6px;font-size:14px;}
        .site-users{color:#a0a0c0;font-size:12px;line-height:1.6;}
        .acct-item{display:flex;justify-content:space-between;align-items:center;background:rgba(0,0,0,.2);border:1px solid rgba(0,242,255,.15);border-radius:6px;padding:6px 10px;margin:6px 0;}
        .acct-item .acct-info{flex:1;min-width:0;}
        .acct-item .acct-user{color:#e0e0ff;font-weight:bold;}
        .acct-item .acct-tag{font-size:10px;color:#00f2ff;background:rgba(0,242,255,.1);padding:2px 6px;border-radius:4px;margin-left:8px;}
        .acct-item .acct-actions{display:flex;gap:6px;opacity:.7;transition:opacity .2s;}
        .acct-item:hover .acct-actions{opacity:1;}
        #auto-fill-status{margin-bottom:12px;padding:6px 10px;border-radius:4px;background:rgba(0,242,255,.08);border:1px solid rgba(0,242,255,.2);font-size:12px;}
        #auto-fill-status.ok{color:#00f2ff;}
        #auto-fill-status.warn{color:#ff0055;}
      </style>
      <header>
        <div class="title">账号管理面板</div>
        <span class="close" onclick="this.parentNode.parentNode.remove()">✕</span>
      </header>
      <div class="content">
        <div class="left">
          <strong>全部站点账号</strong>
          <ul id="all-list"></ul>
        </div>
        <div class="right">
          <strong>当前：${siteKey()}</strong>
          <div id="auto-fill-status" class="ok"></div>
          <ul id="cur-list"></ul>
          <div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <input id="new-user" placeholder="用户名" />
            <input id="new-pwd" placeholder="密码" />
            <button id="add-btn">新增账号</button>
          </div>
          <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;">
            <button id="export-btn">导出 JSON</button>
            <button id="import-btn">导入 JSON</button>
            <button id="selector-btn">手动指定选择器</button>
            <button id="clear-btn" class="danger">清空全部</button>
            <button id="change-key-btn" class="danger">修改主密钥</button>
          </div>
        </div>
      </div>
    `;
        document.body.appendChild(panel);

        /* 左侧：站点 + 账号（每账号单独条目，含查看密码） */
        const allUL = panel.querySelector('#all-list');
        allUL.innerHTML = '';

        GM_listValues().filter(k => k.startsWith('accounts_')).forEach(k => all[k.replace('accounts_', '')] = getAccounts(k.replace('accounts_', '')));
        Object.keys(all).sort().forEach(addr => {
            const list = getAccounts(addr);
            const block = document.createElement('div');
            block.className = 'site-item';
            const name = document.createElement('div');
            name.className = 'site-name';
            name.textContent = addr;
            block.appendChild(name);

            const users = document.createElement('div');
            users.className = 'site-users';
            list.forEach((acc, i) => {
                const item = document.createElement('div');
                item.className = 'acct-item';
                const info = document.createElement('div');
                info.className = 'acct-info';
                info.innerHTML = `<span class="acct-user">${acc.isDefault ? '➤ ' : ''}${acc.user}</span>`;
                if (acc.isDefault) {
                    const tag = document.createElement('span');
                    tag.className = 'acct-tag';
                    tag.textContent = '默认';
                    info.appendChild(tag);
                }
                const actions = document.createElement('div');
                actions.className = 'acct-actions';
                const btnShow = document.createElement('button');
                btnShow.className = 'ghost';
                btnShow.textContent = '👁️';
                btnShow.title = '查看密码';
                btnShow.onclick = () => {
                    const curPwd = document.getElementById('tm-show-pwd');
                    if (curPwd) curPwd.remove();
                    const pwBox = document.createElement('div');
                    pwBox.id = 'tm-show-pwd';
                    pwBox.style.cssText = 'margin-top:6px;padding:6px;border:1px solid #00f2ff;border-radius:4px;background:rgba(0,242,255,.08);color:#00f2ff;font-family:monospace;font-size:12px;word-break:break-all;';
                    pwBox.textContent = decrypt(acc.pass);
                    item.appendChild(pwBox);
                    setTimeout(() => pwBox.remove(), 8000);
                };
                actions.appendChild(btnShow);
                item.appendChild(info);
                item.appendChild(actions);
                users.appendChild(item);
            });
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
          <span class="acct-user">${acc.isDefault ? '➤ ' : ''}${acc.user} ${acc.isDefault ? '<span class="acct-tag">默认</span>' : ''}</span>
          <div class="acct-actions">
            <button data-pwd="${i}">改密码</button>
            <button data-default="${i}">${acc.isDefault ? '取消默认' : '设为默认'}</button>
            <button data-del="${i}" class="danger">删除</button>
            <button data-show="${i}" class="ghost">👁️</button>
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
            curUL.querySelectorAll('[data-show]').forEach(btn =>
                                                          btn.onclick = () => {
                const curPwd = document.getElementById('tm-show-pwd');
                if (curPwd) curPwd.remove();
                const list = getAccounts(siteKey());
                const acc = list[btn.dataset.show];
                const pwBox = document.createElement('div');
                pwBox.id = 'tm-show-pwd';
                pwBox.style.cssText = 'margin-top:6px;padding:6px;border:1px solid #00f2ff;border-radius:4px;background:rgba(0,242,255,.08);color:#00f2ff;font-family:monospace;font-size:12px;word-break:break-all;';
                pwBox.textContent = decrypt(acc.pass);
                btn.parentNode.parentNode.appendChild(pwBox);
                setTimeout(() => pwBox.remove(), 8000);
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
            if (!confirm('导出的文件将包含所有账号的**明文密码**，请妥善保管，不要泄露给他人。确定要导出吗？')) {
                return;
            }
            const data = {};
            GM_listValues()
                .filter(k => k.startsWith('accounts_'))
                .forEach(k => {
                    const site = k.replace('accounts_', '');
                    const list = JSON.parse(GM_getValue(k, '[]'));
                    /* 解密明文导出 */
                    const accounts = list.map(acc => ({
                        user: acc.user,
                        pass: decrypt(acc.pass),
                        isDefault: acc.isDefault || false,
                    }));
                    const sel = JSON.parse(GM_getValue(`selectors_${site}`, '{}'));
                    data[site] = {
                        accounts,
                        selector: sel.user || sel.pwd ? { user: sel.user || '', pwd: sel.pwd || '' } : {},
                    };
                });
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
                        const data = JSON.parse(reader.result);
                        if (typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid');
                        Object.entries(data).forEach(([site, siteData]) => {
                            const accounts = (siteData.accounts || []).map(acc => ({
                                user: acc.user,
                                pass: encrypt(acc.pass), /* 明文重新加密存储 */
                                isDefault: acc.isDefault || false,
                            }));
                            setAccounts(site, accounts);
                            if (siteData.selector) {
                                GM_setValue(`selectors_${site}`, JSON.stringify(siteData.selector));
                            }
                        });
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
        panel.querySelector('#change-key-btn').onclick = () => {
            const hasOldData = GM_listValues().some(k => k.startsWith('accounts_'));
            if (hasOldData && !confirm('检测到已有旧加密账号数据。更换主密钥前，请先点击“导出 JSON”备份明文数据。确定要继续更换主密钥吗？')) {
                return;
            }
            const input = prompt('请输入新主密钥：');
            if (!input || input.trim() === '') {
                alert('主密钥不能为空');
                return;
            }
            const newKey = input.trim();
            GM_setValue('masterKey', newKey);
            MASTER_KEY = newKey;
            alert('主密钥已更新，刷新页面后生效');
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
    const toggleWhiteList = () => {
        const list = getWhiteList();
        const key = siteKey();
        if (list.includes(key)) {
            GM_setValue('whiteList', JSON.stringify(list.filter(k => k !== key)));
            alert(`已取消 ${key} 自动填充`);
        } else {
            list.push(key);
            GM_setValue('whiteList', JSON.stringify(list));
            alert(`已将 ${key} 加入自动填充`);
        }
    };

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

    /* ===== 自动填充触发 ===== */
    const runAutoFill = () => {
        if (inWhiteList()) fill();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runAutoFill);
    } else {
        runAutoFill();
    }

    /* SPA 路由或哈希变化后重新尝试填充 */
    window.addEventListener('popstate', runAutoFill);
    window.addEventListener('hashchange', runAutoFill);
})();
