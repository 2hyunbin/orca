// Bound intrinsic content before flex allocation so raw title length cannot bias its share.
export const TAB_CONTAINER_WIDTH_CLASSES = 'min-w-25 max-w-max flex-[1_1_0px]'

export const TAB_ROOT_WIDTH_CLASSES =
  'w-full max-w-[clamp(6.25rem,calc(100cqw/var(--tab-count,1)),24rem)]'

export const TAB_LABEL_WIDTH_CLASSES = 'min-w-0 flex-1 truncate'
