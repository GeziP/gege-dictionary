import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LexNoteProvider, useLexNote } from './contexts/LexNoteContext';
import { UpdateBanner } from './components/updater/UpdateBanner';

// Keep the initial shell small. Library, settings, review and onboarding pull
// in sizeable feature trees (motion, export/import and provider controls) that
// are not needed until their route is actually shown.
const Library = React.lazy(() => import('./pages/Library').then(({ Library: page }) => ({ default: page })));
const Settings = React.lazy(() => import('./pages/Settings').then(({ Settings: page }) => ({ default: page })));
const Onboarding = React.lazy(() => import('./pages/Onboarding').then(({ Onboarding: page }) => ({ default: page })));
const Lookup = React.lazy(() => import('./pages/Lookup').then(({ Lookup: page }) => ({ default: page })));
const Review = React.lazy(() => import('./pages/Review').then(({ Review: page }) => ({ default: page })));
const OcrSelect = React.lazy(() => import('./pages/OcrSelect').then(({ OcrSelect: page }) => ({ default: page })));

function RouteLoading() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2">
      <span className="text-lg font-bold text-ink">鸽鸽词典</span>
      <span className="text-xs text-ink-subtle">加载中…</span>
    </div>
  );
}

function MainRouter() {
  const { onboarded, initState } = useLexNote();
  const [navPath, setNavPath] = React.useState<string | null>(null);
  const isLookup = window.location.pathname === '/lookup';
  const isOcrSelect = window.location.pathname === '/ocr-select';

  React.useEffect(() => {
    if (isLookup || isOcrSelect) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<{ path: string }>('gege://navigate', (e) => {
          if (e.payload?.path) setNavPath(e.payload.path);
        });
      } catch {
        /* non-tauri */
      }
    })();
    return () => unlisten?.();
  }, [isLookup, isOcrSelect]);

  if (isOcrSelect) {
    return <React.Suspense fallback={<RouteLoading />}><OcrSelect /></React.Suspense>;
  }

  if (isLookup) {
    return <React.Suspense fallback={<RouteLoading />}><Lookup /></React.Suspense>;
  }

  if (initState === 'loading') {
    return <RouteLoading />;
  }

  if (!onboarded) {
    return (
      <React.Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="*" element={<Navigate to="/onboarding" replace />} />
        </Routes>
      </React.Suspense>
    );
  }

  if (navPath) {
    return (
      <React.Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Settings />} />
        </Routes>
      </React.Suspense>
    );
  }

  return (
    <React.Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/" element={<Navigate to="/library" replace />} />
        <Route path="/library" element={<Library />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/review" element={<Review />} />
        <Route path="/onboarding" element={<Navigate to="/library" replace />} />
        <Route path="/lookup" element={<Lookup />} />
        <Route path="*" element={<Navigate to="/library" replace />} />
      </Routes>
    </React.Suspense>
  );
}

function StartupWarningsBanner() {
  const { startupWarnings } = useLexNote();
  if (startupWarnings.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-3 top-3 z-50 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-ink shadow-window"
    >
      <p className="font-medium text-ink">启动警告</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {startupWarnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
      </ul>
    </div>
  );
}

export function App() {
  return (
    <LexNoteProvider>
      <BrowserRouter>
        <div className="h-full w-full bg-canvas text-ink">
          <UpdateBanner />
          <StartupWarningsBanner />
          <MainRouter />
        </div>
      </BrowserRouter>
    </LexNoteProvider>
  );
}
