type MeasuredMethod = (...args: never[]) => unknown

type MethodKey<Owner> = {
  [Key in keyof Owner]-?: Owner[Key] extends MeasuredMethod ? Key : never
}[keyof Owner]

type Method<Owner, Key extends keyof Owner> = Extract<Owner[Key], MeasuredMethod>

export type PopulationWrap = <Owner extends object, Key extends MethodKey<Owner>>(
  target: Owner,
  property: Key,
  intercept: (
    owner: Owner,
    args: Parameters<Method<Owner, Key>>,
    call: (args: Parameters<Method<Owner, Key>>) => ReturnType<Method<Owner, Key>>
  ) => unknown
) => void

/** Preserve receiver, tuple, exceptions and own/inherited restoration for real method owners. */
export function populationMethodWrapper(restores: (() => void)[]): PopulationWrap {
  return (target, property, intercept) => {
    type Owner = typeof target
    type SelectedMethod = Method<Owner, typeof property>
    const descriptor = Object.getOwnPropertyDescriptor(target, property)
    const original = target[property]
    if (typeof original !== 'function') {
      throw new Error(`missing measured method ${String(property)}`)
    }
    // SAFETY: MethodKey selects this checked method; only its original receiver/tuple are forwarded.
    const invoke = original as (
      this: Owner,
      ...args: Parameters<SelectedMethod>
    ) => ReturnType<SelectedMethod>
    Object.defineProperty(target, property, {
      configurable: true,
      writable: true,
      value: function (this: Owner, ...args: Parameters<SelectedMethod>) {
        return intercept(this, args, (values) => invoke.apply(this, values))
      }
    })
    restores.push(() => {
      if (descriptor) {
        Object.defineProperty(target, property, descriptor)
      } else {
        Reflect.deleteProperty(target, property)
      }
    })
  }
}
