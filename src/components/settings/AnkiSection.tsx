import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { Toggle } from '../ui/Toggle';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { SettingsSection } from './SettingsSection';
import * as bridge from '../../lib/tauri-bridge';

export function AnkiSection() {
  const { settings, updateSettings } = useLexNote();
  const anki = useMemo(
    () =>
      settings.anki || {
        enabled: false,
        host: '127.0.0.1',
        port: 8765,
        deck: 'Default',
        model: 'Basic',
        autoSend: false,
      },
    [settings.anki]
  );
  const [status, setStatus] = useState<string | null>(null);
  const [decks, setDecks] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const patch = useCallback(
    (p: Partial<typeof anki>) => {
      updateSettings({ anki: { ...anki, ...p } });
    },
    [anki, updateSettings]
  );

  const test = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await bridge.testAnkiConnection();
      setStatus(`连接成功 · Anki API v${String(res.version)}`);
      const [d, m] = await Promise.all([bridge.listAnkiDecks(), bridge.listAnkiModels()]);
      setDecks(d);
      setModels(m);
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!anki.enabled) {
      setDecks([]);
      setModels([]);
    }
  }, [anki.enabled]);

  return (
    <SettingsSection
      title="Anki 同步"
      description="可选：将生词发送到本机 Anki（需安装 AnkiConnect）。默认关闭，关闭时不发起任何网络请求。"
    >
      <Toggle
        checked={anki.enabled}
        onChange={(v) => patch({ enabled: v })}
        label="启用 Anki Connect"
        description="仅连接 127.0.0.1，不上传到云端。"
      />
      {anki.enabled && (
        <div className="mt-3 space-y-3 rounded-md border border-line bg-raised p-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="mb-1 text-[11px] text-ink-muted">牌组</p>
              <Select
                value={anki.deck}
                onChange={(e) => patch({ deck: e.target.value })}
                options={[
                  { value: anki.deck, label: anki.deck || '选择牌组' },
                  ...decks.filter((d) => d !== anki.deck).map((d) => ({ value: d, label: d })),
                ]}
              />
            </div>
            <div>
              <p className="mb-1 text-[11px] text-ink-muted">笔记类型</p>
              <Select
                value={anki.model}
                onChange={(e) => patch({ model: e.target.value })}
                options={[
                  { value: anki.model, label: anki.model || '选择类型' },
                  ...models.filter((m) => m !== anki.model).map((m) => ({ value: m, label: m })),
                ]}
              />
            </div>
          </div>
          <Toggle
            checked={anki.autoSend}
            onChange={(v) => patch({ autoSend: v })}
            label="收藏后自动发送"
            description="开启后，查词窗点「加入生词库」会尝试同步到 Anki（Anki 未开则静默失败）。"
          />
          <details className="rounded-md border border-line bg-sunken/40 px-2.5 py-2">
            <summary className="cursor-pointer text-[11px] text-ink-muted">高级 · 字段映射</summary>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(
                [
                  ['front', 'Front 字段'],
                  ['back', 'Back 字段'],
                  ['extra', 'Extra 字段'],
                  ['examples', 'Example 字段（可空）'],
                ] as const
              ).map(([key, label]) => (
                <div key={key}>
                  <p className="mb-1 text-[10px] text-ink-subtle">{label}</p>
                  <input
                    className="w-full rounded border border-line bg-raised px-2 py-1 text-[11px] text-ink"
                    value={
                      (anki.fieldMap?.[key] ??
                        (key === 'front' ? 'Front' : key === 'back' ? 'Back' : key === 'extra' ? 'Extra' : '')) as string
                    }
                    onChange={(e) =>
                      patch({
                        fieldMap: {
                          front: anki.fieldMap?.front || 'Front',
                          back: anki.fieldMap?.back || 'Back',
                          extra: anki.fieldMap?.extra || 'Extra',
                          examples: anki.fieldMap?.examples || '',
                          [key]: e.target.value,
                        },
                      })
                    }
                    spellCheck={false}
                  />
                </div>
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-[11px] text-ink-muted">
              <input
                type="checkbox"
                className="h-3 w-3"
                checked={anki.includeExamplesInExtra !== false}
                onChange={(e) => patch({ includeExamplesInExtra: e.target.checked })}
              />
              未配置 Example 字段时，把例句写入 Extra
            </label>
            <p className="mt-1 text-[10px] text-ink-subtle">
              Basic 模型忽略未知字段；发送失败会自动回退仅 Front/Back。
            </p>
          </details>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void test()} disabled={busy}>
              {busy ? '连接中…' : '测试连接并刷新列表'}
            </Button>
            {status && <span className="text-[11px] text-ink-muted">{status}</span>}
          </div>
          <p className="text-[10px] text-ink-subtle">
            Anki 需保持运行并安装 AnkiConnect 插件（默认端口 8765）。发送时 Front=词条，Back=译文与语境。
          </p>
        </div>
      )}
    </SettingsSection>
  );
}
