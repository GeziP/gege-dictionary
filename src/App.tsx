import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LexNoteProvider, useLexNote } from './contexts/LexNoteContext';
import { Library } from './pages/Library';
import { Settings } from './pages/Settings';
import { Onboarding } from './pages/Onboarding';
import { Lookup } from './pages/Lookup';

function MainRouter() {
  const { onboarded, initState } = useLexNote();
  const isLookup = window.location.pathname === '/lookup';

  if (isLookup) {
    return <Lookup />;
  }

  if (initState === 'loading') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2">
        <span className="text-lg font-bold text-ink">鸽鸽词典</span>
        <span className="text-xs text-ink-subtle">加载中…</span>
      </div>
    );
  }

  if (!onboarded) {
    return (
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/library" replace />} />
      <Route path="/library" element={<Library />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/onboarding" element={<Navigate to="/library" replace />} />
      <Route path="/lookup" element={<Lookup />} />
      <Route path="*" element={<Navigate to="/library" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <LexNoteProvider>
      <BrowserRouter>
        <div className="h-full w-full bg-canvas text-ink">
          <MainRouter />
        </div>
      </BrowserRouter>
    </LexNoteProvider>
  );
}
