interface Props {
  direction?: 'horizontal' | 'vertical'
  onMouseDown: (e: React.MouseEvent) => void
}

export default function ResizeHandle({ direction = 'horizontal', onMouseDown }: Props) {
  const isH = direction === 'horizontal'
  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        flexShrink: 0,
        width:  isH ? 4 : '100%',
        height: isH ? '100%' : 4,
        cursor: isH ? 'col-resize' : 'row-resize',
        background: 'transparent',
        position: 'relative',
        zIndex: 10,
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--tab-accent)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    />
  )
}
