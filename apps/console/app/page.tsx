import { Suspense } from 'react';
import { Dashboard } from '../components/dashboard';
export default function Page() {
  return (
    <Suspense fallback={<div className="boot-screen">正在加载工作台…</div>}>
      <Dashboard />
    </Suspense>
  );
}
