import { ComponentProps } from '../ui/base'

export function createComponent(props: ComponentProps) {
  return { ...props, createdAt: new Date() }
}