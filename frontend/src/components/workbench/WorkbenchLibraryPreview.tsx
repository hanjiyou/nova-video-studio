'use client';
import { useEffect, useRef, useState } from 'react';
import type { HistoryTask } from '@/lib/workbench-client';
import { AssetActions, WorkbenchDialog } from './WorkbenchResults';

export function WorkbenchLibraryPreview({ task, onClose }: { task: HistoryTask; onClose: () => void }) {
  const asset = task.outputAssets?.[0];
  const [mediaError, setMediaError] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const available = asset?.availability === 'available' && Boolean(asset.previewUrl) && (asset.kind === 'image' || asset.kind === 'video');
  const image = asset ? asset.kind === 'image' : task.mediaKind === 'image' || task.mode.startsWith('image') || task.mode.includes('to-image');

  useEffect(() => {
    const player = video.current;
    // StrictMode replays effects after cleanup; restore the same managed source.
    if (player && asset?.previewUrl) player.setAttribute('src', asset.previewUrl);
    return () => {
      if (!player) return;
      player.pause();
      player.removeAttribute('src');
      player.load();
    };
  }, [asset?.assetId, asset?.previewUrl, mediaError]);

  const unavailableReason = !asset
    ? task.status === 'download_failed'
      ? '结果尚未保存到本机，请从“任务详情”查看下载原因或手动重新下载。'
      : task.status === 'completed'
        ? '此记录没有可用的本机输出文件，请从“任务详情”查看记录或恢复结果。'
        : '本机结果尚未保存完成，请从“任务详情”查看当前进度和原因。'
    : asset.availability === 'missing'
      ? '结果文件已被外部移除，请从“任务详情”查看记录或尝试手动重新下载。'
      : asset.availability === 'corrupt'
        ? '结果文件已损坏，请从“任务详情”查看记录或尝试手动重新下载。'
        : '此输出暂无可用的图片或视频预览，请从“任务详情”查看记录。';

  return <WorkbenchDialog title={image ? '图片预览' : '视频预览'} onClose={onClose}>
    <div className="wb-library-preview">
      {available && !mediaError ? <div className="wb-library-preview-media">
        {asset.kind === 'image'
          ? <img src={asset.previewUrl} alt={task.prompt || '本机图片作品'} onError={() => setMediaError('图片加载失败，文件可能已被移动、删除或损坏。可从“任务详情”查看记录或尝试手动重新下载。')} />
          : <video ref={video} src={asset.previewUrl} controls playsInline preload="metadata" aria-label="作品库视频预览" onError={() => setMediaError('视频无法播放，可能是文件无法读取或浏览器不支持该编码。可另存后使用其他播放器，或从“任务详情”查看记录。')} />}
      </div> : <div className="wb-empty" role={mediaError ? 'alert' : 'status'}>
        <h3>暂无可预览结果</h3><p>{mediaError || unavailableReason}</p>
      </div>}
      <p className="wb-help">{asset?.displayName || task.model}{available && asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}</p>
      <p className="wb-help">关闭预览后，可从作品卡片的“任务详情”查看参数、进度和恢复操作。</p>
      <AssetActions asset={available ? asset : undefined} />
    </div>
  </WorkbenchDialog>;
}
