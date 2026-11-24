import { useEffect, useRef, type ReactNode } from 'react'

export function Modal({
  children,
  onClose,
  label,
  className = 'dialog',
}: {
  children: ReactNode
  onClose: () => void
  label: string
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    const priorFocus = document.activeElement
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (priorFocus instanceof HTMLElement && priorFocus.isConnected)
        priorFocus.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={className}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const rect = e.currentTarget.getBoundingClientRect()
          if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
          )
            onClose()
        }
      }}
    >
      {children}
    </dialog>
  )
}
