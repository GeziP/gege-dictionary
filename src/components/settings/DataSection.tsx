import React, { useCallback, useEffect, useState } from 'react';
import {
  DatabaseIcon,
  FolderOpenIcon,
  HardDriveDownloadIcon,
  Loader2Icon,
  ShieldIcon,
  Trash2Icon,
} from 'lucide-react';
import { useLexNote } from '../../contexts/LexNoteContext';
import { Button } from '../ui/Button';
import { TextInput } from '../ui/TextInput';
import { Toggle } from '../ui/Toggle';
import { SettingsSection } from './SettingsSection';
import * as bridge from '../../lib/tauri-bridge';

interface Backup {
  name: string;
  sizeKb: number;
  modifiedTs: number;
}

interface DbInfo {
  wordCount: number;
  sizeBytes: number;
  dataDir: string;
  cacheCount: number;
  cacheSizeBytes: number;
}

export function DataSection() {
  const { settings, updateSettings, usage } = useLexNote();
  const isTauri = bridge.isTauri();
  const [status, setStatus] = useState<{ type: 'ok' | 'error'; msg: string } | null>(null);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [newDir, setNewDir] = useState('');
  const [loading, setLoading] = useState<string | null>(null);

  const flash = (type: 'ok' | 'error', msg: string) => {
    setStatus({ type, msg });
    setTimeout(() => setStatus(null), 5000);
  };

  const loadInfo = useCallback(async () => {
    if (!isTauri) return;
    try {
      const [stats, bks] = await Promise.all([
        bridge.getDbStats() as Promise<DbInfo & { tagCount: number }>,
        bridge.listBackups(),
      ]);
      setDbInfo({
        wordCount: stats.wordCount,
        sizeBytes: stats.sizeBytes,
        dataDir: stats.dataDir,
        cacheCount: stats.cacheCount,
        cacheSizeBytes: stats.cacheSizeBytes,
      });
      setNewDir(stats.dataDir);
      setBackups(bks as Backup[]);
    } catch (e) {
      console.error('Failed to load data info:', e);
    }
  }, [isTauri]);

  useEffect(() => { loadInfo(); }, [loadInfo]);

  const handleBackup = async () => {
    setLoading('backup');
    try {
      const name = await bridge.backupDatabase();
      flash('ok', `已备份为 ${name}`);
      loadInfo();
    } catch (e) {
      flash('error', `备份失败: ${e}`);
    } finally {
      setLoading(null);
    }
  };

  const handleRestore = async (name: string) => {
    if (!confirm(`确定要恢复到 ${name} 吗？当前数据会先自动备份。`)) return;
    setLoading(`restore-${name}`);
    try {
      await bridge.restoreBackup(name);
      flash('ok', `已从 ${name} 恢复，当前数据已自动备份`);
      loadInfo();
    } catch (e) {
      flash('error', `恢复失败: ${e}`);
    } finally {
      setLoading(null);
    }
  };

  const handlePickFolder = async () => {
    try {
      const chosen = await bridge.pickFolder('选择数据目录');
      if (chosen) setNewDir(chosen);
    } catch (e) {
      flash('error', `选择文件夹失败: ${e}`);
    }
  };

  const handleChangeDir = async () => {
    if (!newDir.trim() || newDir === dbInfo?.dataDir) {
      flash('error', '请输入不同的目录路径');
      return;
    }
    if (!confirm(`确定要将数据迁移到 ${newDir} 吗？原目录文件不会删除。`)) return;
    setLoading('changedir');
    try {
      await bridge.changeDataDir(newDir);
      flash('ok', `数据已迁移到 ${newDir}，重启后生效`);
      loadInfo();
    } catch (e) {
      flash('error', `迁移失败: ${e}`);
    } finally {
      setLoading(null);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await bridge.openDataFolder();
    } catch (e) {
      flash('error', `打开文件夹失败: ${e}`);
    }
  };

  const handleExportAll = async () => {
    try {
      const words = await bridge.getAllWords();
      const ids = words.map((w: { id: string }) => w.id);
      if (ids.length === 0) {
        flash('error', '词库为空，无数据可导出');
        return;
      }
      const csv = await bridge.exportWordsData(ids, 'csv');
      const chosen = await bridge.pickFolder('选择导出目录');
      if (!chosen) return;
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gege-export-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      flash('ok', `已导出 ${ids.length} 条词条`);
    } catch (e) {
      flash('error', `导出失败: ${e}`);
    }
  };

  const handleClearDb = async () => {
    if (!confirm('确定要清空所有词条？此操作不可逆！建议先备份。')) return;
    if (!confirm('再次确认：清空后无法恢复，确定要继续吗？')) return;
    try {
      const words = await bridge.getAllWords();
      const ids = words.map((w: { id: string }) => w.id);
      if (ids.length > 0) {
        await bridge.deleteWords(ids);
      }
      flash('ok', `已清空 ${ids.length} 条词条`);
      loadInfo();
    } catch (e) {
      flash('error', `清空失败: ${e}`);
    }
  };

  const handleClearCache = async () => {
    setLoading('clear-cache');
    try {
      const count = await bridge.clearCache();
      flash('ok', `已清空 ${count} 条缓存`);
      await loadInfo();
    } catch (e) {
      flash('error', `清空缓存失败: ${e}`);
    } finally {
      setLoading(null);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  };

  return (
    <div className="space-y-3">
      <SettingsSection title="数据位置" description="所有数据存放于本机单一 SQLite 文件，可迁移到同步盘目录。">
        <div className="flex gap-2">
          <TextInput
            value={newDir}
            onChange={(event) => setNewDir(event.target.value)}
            leading={<FolderOpenIcon size={13} />}
            className="flex-1 font-mono" />
          <Button onClick={handlePickFolder} variant="ghost">浏览…</Button>
          <Button
            onClick={handleChangeDir}
            disabled={loading === 'changedir' || !newDir.trim() || newDir === dbInfo?.dataDir}>
            {loading === 'changedir' ? <Loader2Icon size={13} className="animate-spin" /> : '迁移'}
          </Button>
        </div>
        <div className="mt-1">
          <Button onClick={handleOpenFolder} variant="ghost" size="sm">在资源管理器中打开当前目录</Button>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-subtle">
          <DatabaseIcon size={12} />
          gege.db · {dbInfo?.wordCount ?? 0} 条词条 · {formatSize(dbInfo?.sizeBytes ?? 0)} · FTS5 全文索引已建立
        </p>
      </SettingsSection>

      <SettingsSection title="备份与恢复">
        <Toggle
          checked={settings.autoBackup}
          onChange={(value) => updateSettings({ autoBackup: value })}
          label="每日自动本地备份"
          description="保留最近 10 份，存放于数据目录下的 backups 文件夹。" />

        {backups.length > 0 && (
          <ul className="mt-2 space-y-1">
            {backups.map((backup) => (
              <li key={backup.name} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5">
                <span className="flex-1 truncate font-mono text-[11px] text-ink-muted">
                  {backup.name}
                </span>
                <span className="text-[10px] text-ink-subtle">
                  {formatDate(backup.modifiedTs)} · {backup.sizeKb} KB
                </span>
                <button
                  type="button"
                  onClick={() => handleRestore(backup.name)}
                  disabled={loading === `restore-${backup.name}`}
                  className="text-[11px] text-accent hover:underline disabled:opacity-50">
                  {loading === `restore-${backup.name}` ? '恢复中…' : '恢复'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {backups.length === 0 && (
          <p className="mt-2 text-[11px] text-ink-subtle">暂无备份文件</p>
        )}
        <Button
          className="mt-2"
          size="sm"
          icon={loading === 'backup' ? <Loader2Icon size={12} className="animate-spin" /> : <HardDriveDownloadIcon size={12} />}
          disabled={loading === 'backup'}
          onClick={handleBackup}>
          立即备份
        </Button>
      </SettingsSection>

      <SettingsSection title="查询缓存" description="重复查询会直接使用本地结果，不消耗模型额度。">
        <div className="flex items-center gap-2">
          <label className="flex flex-1 items-center gap-2 text-[11px] text-ink-muted">
            有效期
            <select
              value={settings.cacheTtlDays ?? 30}
              onChange={(event) => updateSettings({ cacheTtlDays: Number(event.target.value) as 0 | 7 | 30 | 90 })}
              className="h-7 rounded border border-line bg-surface px-2 text-[11px] text-ink"
            >
              <option value={7}>7 天</option>
              <option value={30}>30 天</option>
              <option value={90}>90 天</option>
              <option value={0}>永不过期</option>
            </select>
          </label>
          <Button
            size="sm"
            variant="ghost"
            disabled={loading === 'clear-cache' || !dbInfo?.cacheCount}
            onClick={handleClearCache}
          >
            {loading === 'clear-cache' ? '清理中…' : '清空缓存'}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-ink-subtle">
          当前 {dbInfo?.cacheCount ?? 0} 条 · {formatSize(dbInfo?.cacheSizeBytes ?? 0)}
        </p>
      </SettingsSection>

      <SettingsSection title="用量" description="仅在本机统计，不上报。token 数为按字符估算值，实际以服务商账单为准。">
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: '今日查询', value: `${usage.today} 次` },
            { label: '本月查询', value: `${usage.month} 次` },
            { label: '本月估算 token', value: `${(usage.tokens / 1000).toFixed(1)}k` },
          ].map((item) => (
            <div key={item.label} className="rounded-md border border-line bg-raised px-3 py-2">
              <p className="text-[10px] text-ink-subtle">{item.label}</p>
              <p className="mt-0.5 text-[15px] font-semibold text-ink">{item.value}</p>
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="隐私边界">
        <div className="rounded-md border border-line bg-raised p-3 text-[12px] leading-relaxed text-ink-muted">
          <p className="flex items-center gap-1.5 font-medium text-ink">
            <ShieldIcon size={13} className="text-positive" /> 发送给模型的只有三样东西
          </p>
          <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
            <li>你选中的文本</li>
            <li>抓取的上下文句子（可在「取词与上下文」中关闭）</li>
            <li>当前 Prompt 模板</li>
          </ol>
          <p className="mt-2">
            鸽鸽词典没有服务端，不收集任何内容；崩溃日志默认不包含用户文本，API Key 在日志中脱敏。
          </p>
        </div>
        <Toggle
          checked={settings.anonymousStats}
          onChange={(value) => updateSettings({ anonymousStats: value })}
          label="发送匿名使用统计"
          description="默认关闭。开启后仅上报功能使用次数，不含任何词汇或上下文内容。" />

        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={handleExportAll}>
            导出全部数据
          </Button>
          <Button size="sm" variant="danger" icon={<Trash2Icon size={12} />} onClick={handleClearDb}>
            清空数据库
          </Button>
        </div>
      </SettingsSection>

      {status && (
        <p className={`rounded-md border px-3 py-2 text-[11px] ${
          status.type === 'ok'
            ? 'border-line bg-accent-soft text-accent'
            : 'border-danger/30 bg-danger/5 text-danger'
        }`}>
          {status.msg}
        </p>
      )}
    </div>
  );
}
