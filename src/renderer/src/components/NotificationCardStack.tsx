import type { ReactNode } from 'react'

export function NotificationCardStack({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="pointer-events-none fixed top-[calc(2.5rem+env(safe-area-inset-top,0px))] right-4 z-50 flex max-h-[calc(100vh-80px-env(safe-area-inset-top,0px))] w-[360px] max-w-[calc(100vw-32px)] flex-col-reverse gap-2 overflow-y-auto scrollbar-sleek [&>*]:pointer-events-auto [&>*]:shrink-0 max-[480px]:left-4 max-[480px]:right-4 max-[480px]:w-auto">
      {children}
    </div>
  )
}
