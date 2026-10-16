export const safely = (action, onFailure) => {
  try {
    return action()
  } catch {
    try {
      return onFailure?.()
    } catch {
      return undefined
    }
  }
}

export function createCloseStageMethods({ isActive, record, unavailable, undo, pending }) {
  const settle = (result, stage, done) => {
    safely(() => {
      if (!isActive()) {
        return
      }
      if (!(result instanceof Promise)) {
        record(`${stage}.sync-return`)
        done?.()
        return
      }
      pending.set(stage, (pending.get(stage) ?? 0) + 1)
      const finish = (suffix, value) =>
        safely(() => {
          if (!isActive()) {
            return
          }
          pending.set(stage, Math.max(0, (pending.get(stage) ?? 1) - 1))
          record(stage + suffix)
          done?.(value)
        })
      // Handlers are nonthrowing; the original promise is returned unchanged.
      Promise.prototype.then.call(
        result,
        (value) => {
          finish('.resolved', value)
        },
        () => {
          finish('.rejected')
        }
      )
    })
  }
  const decorate = (original, stage, before, after) =>
    function (...args) {
      if (!isActive()) {
        // oxlint-disable-next-line anti-slop/no-reflect-apply -- Diagnostic wrappers preserve the original method's receiver and arguments.
        return Reflect.apply(original, this, args)
      }
      record(`${stage}.enter`)
      safely(() => before?.())
      let result
      try {
        // oxlint-disable-next-line anti-slop/no-reflect-apply -- Diagnostic wrappers preserve the original method's receiver and arguments.
        result = Reflect.apply(original, this, args)
      } catch (error) {
        record(`${stage}.threw`)
        safely(() => after?.())
        throw error
      }
      settle(result, stage, after)
      return result
    }
  const replace = (owner, key, value, stage) => {
    if (!owner) {
      unavailable(stage)
      return false
    }
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if ((descriptor && !descriptor.configurable) || (!descriptor && !Object.isExtensible(owner))) {
      unavailable(stage)
      return false
    }
    Object.defineProperty(owner, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? false,
      writable: true,
      value
    })
    undo.push(() => {
      if (descriptor) {
        Object.defineProperty(owner, key, descriptor)
      } else {
        Reflect.deleteProperty(owner, key)
      }
    })
    return true
  }
  const wrap = (owner, key, stage, before, after) =>
    safely(
      () => {
        const original = owner?.[key]
        if (typeof original !== 'function') {
          unavailable(stage)
          return
        }
        replace(owner, key, decorate(original, stage, before, after), stage)
      },
      () => unavailable(stage)
    )
  const proxyField = (owner, field, method, stage) =>
    safely(
      () => {
        const original = owner?.[field]
        if (!original || typeof original[method] !== 'function') {
          unavailable(stage)
          return
        }
        const wrappers = new WeakMap()
        const observed = new Proxy(original, {
          get(target, key, receiver) {
            // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap forwards the original receiver for accessors.
            const value = Reflect.get(target, key, receiver)
            if (key !== method || typeof value !== 'function') {
              return value
            }
            let wrapper = wrappers.get(value)
            if (!wrapper) {
              wrapper = decorate(value, stage)
              wrappers.set(value, wrapper)
            }
            return wrapper
          }
        })
        replace(owner, field, observed, stage)
      },
      () => unavailable(stage)
    )
  const listen = (owner, event, stage, after) =>
    safely(
      () => {
        if (typeof owner?.on !== 'function' || typeof owner?.off !== 'function') {
          unavailable(stage)
          return
        }
        const listener = () => {
          record(stage)
          safely(() => after?.())
        }
        owner.on(event, listener)
        undo.push(() => owner.off(event, listener))
      },
      () => unavailable(stage)
    )
  const promise = (owner, key, stage, after) =>
    safely(
      () => {
        const result = owner?.[key]
        if (!(result instanceof Promise)) {
          unavailable(stage)
          return
        }
        record(`${stage}.observed`)
        settle(result, stage, after)
      },
      () => unavailable(stage)
    )
  const snapshotConnection = (connection, label) =>
    safely(
      () => {
        if (!connection) {
          unavailable(`${label}.snapshot`)
          return
        }
        record(label + (connection._closed === true ? '.closed' : '.not-confirmed-closed'))
        const state = connection._transport?._ws?.readyState
        record(
          label +
            (Number.isInteger(state) && state >= 0 && state <= 3
              ? '.ws-state-' + state
              : '.ws-state-unavailable')
        )
        let count = 0
        if (!(connection._sessions instanceof Map)) {
          unavailable(`${label}.callbacks`)
          return
        }
        for (const session of connection._sessions.values()) {
          if (!(session?._callbacks instanceof Map)) {
            unavailable(`${label}.callbacks`)
            return
          }
          count += session._callbacks.size
        }
        record(label + (count === 0 ? '.callbacks-zero' : '.callbacks-pending'))
      },
      () => unavailable(`${label}.snapshot`)
    )
  const connection = (object, label) =>
    safely(
      () => {
        if (!object) {
          unavailable(label)
          return
        }
        wrap(object, 'close', `${label}.close-request`)
        wrap(object.rootSession, 'dispose', `${label}.root-session-dispose`)
        listen(object._transport?._ws, 'close', `${label}.socket-close`)
        const symbol = object
          .eventNames?.()
          .find(
            (name) =>
              typeof name === 'symbol' && name.description === 'ConnectionEvents.Disconnected'
          )
        if (symbol) {
          listen(object, symbol, `${label}.disconnected`)
        } else {
          unavailable(`${label}.disconnected-symbol`)
        }
      },
      () => unavailable(label)
    )

  return { wrap, proxyField, listen, promise, snapshotConnection, connection }
}
