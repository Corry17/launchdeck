'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import {
  X,
  Loader2,
  Globe2,
  Smartphone,
  MessageCircle,
  Server,
  Triangle,
  Terminal,
  CheckCircle2,
  AlertTriangle,
  Info,
} from 'lucide-react';
import { statusLabels, type Provider, type ProductType, type Status } from '../domain';
export const cn = (...values: ClassValue[]) => twMerge(clsx(values));
const buttonVariants = cva('button', {
  variants: {
    variant: {
      primary: 'button-primary',
      secondary: 'button-secondary',
      ghost: 'button-ghost',
      danger: 'button-danger',
    },
    size: { normal: '', small: 'button-small', icon: 'button-icon' },
  },
  defaultVariants: { variant: 'primary', size: 'normal' },
});
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> &
    VariantProps<typeof buttonVariants> & { asChild?: boolean; loading?: boolean }
>(function Button(
  { className, variant, size, asChild, loading, children, disabled, ...props },
  ref,
) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      className={cn(buttonVariants({ variant, size }), className)}
      ref={ref}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 size={16} className="spin" /> : null}
      {children}
    </Component>
  );
});
export function Modal({
  title,
  description,
  children,
  open,
  onClose,
  className,
}: {
  title: string;
  description: string;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={cn('modal', className)}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button size="icon" variant="ghost" aria-label="关闭窗口">
                <X size={19} />
              </Button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('field', className)}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}
export function ProductIcon({ type, size = 24 }: { type: ProductType; size?: number }) {
  const Icon = type === 'web' ? Globe2 : type === 'app' ? Smartphone : MessageCircle;
  return <Icon size={size} strokeWidth={1.7} />;
}
export function ProviderIcon({
  provider,
  size = 19,
}: {
  provider: Provider | 'github';
  size?: number;
}) {
  const Icon =
    provider === 'vercel'
      ? Triangle
      : provider === 'docker'
        ? Server
        : provider === 'wechat'
          ? MessageCircle
          : provider === 'github'
            ? Terminal
            : Smartphone;
  return (
    <Icon size={size} fill={provider === 'vercel' ? 'currentColor' : 'none'} strokeWidth={1.7} />
  );
}
export function Badge({
  children,
  tone = 'neutral',
  dot = false,
}: {
  children: ReactNode;
  tone?: string;
  dot?: boolean;
}) {
  return (
    <span className={cn('badge', `badge-${tone}`)}>
      {dot && <i />}
      {children}
    </span>
  );
}
export function StatusBadge({ status }: { status: Status }) {
  const tone =
    status === 'SUCCEEDED'
      ? 'green'
      : status === 'FAILED'
        ? 'red'
        : ['QUEUED', 'RUNNING', 'WAITING_EXTERNAL'].includes(status)
          ? 'blue'
          : ['WAITING_MANUAL', 'UNKNOWN'].includes(status)
            ? 'amber'
            : 'neutral';
  return (
    <Badge tone={tone} dot>
      {statusLabels[status]}
    </Badge>
  );
}
export function Notice({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'success' | 'error';
}) {
  const Icon =
    tone === 'success'
      ? CheckCircle2
      : tone === 'warning' || tone === 'error'
        ? AlertTriangle
        : Info;
  return (
    <div className={cn('notice', `notice-${tone}`)} role={tone === 'error' ? 'alert' : undefined}>
      <Icon size={17} />
      <div>{children}</div>
    </div>
  );
}
export function EmptyState({
  icon,
  title,
  text,
  children,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}
