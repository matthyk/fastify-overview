'use strict'

const fp = require('fastify-plugin')
const getSource = require('./lib/source-code')

const kTrackerMe = Symbol('fastify-overview.track-me')
const kStructure = Symbol('fastify-overview.structure')
const kSourceRegister = Symbol('fastify-overview.source.register')
const kSourceRoute = Symbol('fastify-overview.source.route')

const {
  transformRoute,
  getDecoratorNode,
  getPluginNode,
  getHookNode,
  filterStructure
} = require('./lib/utils')

function fastifyOverview (fastify, options, next) {
  const opts = Object.assign({
    addSource: false
  }, options)

  const contextMap = new Map()
  let structure

  fastify.addHook('onRegister', function markInstance (instance) {
    const parent = Object.getPrototypeOf(instance)
    // this is the `avvio` instance
    manInTheMiddle.call(this, instance, parent[kTrackerMe])
  })

  fastify.addHook('onRoute', function markRoute (routeOpts) {
    const routeNode = Object.assign(transformRoute(routeOpts), opts.onRouteDefinition?.(routeOpts))
    if (opts.addSource) {
      routeNode.source = routeOpts.handler[kSourceRoute]

      // the hooks added using the route options, does not have the `source` property
      // so we can use the same as the route handler
      const hooksKey = Object.keys(routeNode.hooks)
      for (const hookKey of hooksKey) {
        routeNode.hooks[hookKey].forEach(hookNode => {
          hookNode.source = routeNode.source
        })
      }
    }
    this[kStructure].routes.push(routeNode)
  })

  fastify.addHook('onReady', function hook (done) {
    const root = contextMap.get(rootToken)
    structure = root
    contextMap.clear()
    done(null)
  })

  fastify.decorate('overview', function getOverview (opts) {
    if (!structure) {
      throw new Error('Fastify must be in ready status to access the overview')
    }
    if (opts?.hideEmpty || opts?.routesFilter) {
      return filterStructure(structure, opts)
    }
    return structure
  })

  const rootToken = manInTheMiddle(fastify)
  wrapFastify(fastify, opts)

  if (opts.exposeRoute === true) {
    const routeConfig = Object.assign(
      {
        method: 'GET',
        exposeHeadRoute: false,
        url: '/json-overview'
      },
      opts.exposeRouteOptions,
      { handler: getJsonOverview })
    fastify.route(routeConfig)
  }

  next()

  function manInTheMiddle (instance, parentId) {
    const trackingToken = Math.random()
    instance[kTrackerMe] = trackingToken

    const trackStructure = getPluginNode(trackingToken, instance.pluginName)
    if (opts.addSource && this) {
      trackStructure.source = this._current.find(loadPipe => loadPipe.func[kSourceRegister] !== undefined).func[kSourceRegister]
    }
    contextMap.set(trackingToken, trackStructure)
    instance[kStructure] = trackStructure

    if (parentId) {
      contextMap.get(parentId).children.push(trackStructure)
    }

    return trackingToken
  }
}

/**
 * this function is executed only once: when the plugin is registered.
 * if it is executed more than once, the output structure will have duplicated
 * entries.
 * this is caused by the fact that the wrapDecorate will call wrapDecorate again and so on.
 * Running the code only the first time relies on the Fastify prototype chain.
 *
 * The key here is to use the this[kStructure] property to get the right structure to update.
 */
function wrapFastify (instance, pluginOpts) {
  // *** decorators
  wrapDecorator(instance, 'decorate', pluginOpts)
  wrapDecorator(instance, 'decorateRequest', pluginOpts)
  wrapDecorator(instance, 'decorateReply', pluginOpts)

  // *** register
  const originalRegister = instance.register
  instance.register = function wrapRegister (pluginFn, opts) {
    if (isPromiseLike(pluginFn)) {
      instance.log.warn('Promise like plugin functions are not supported by fastify-overview.')
      return originalRegister.call(this, pluginFn, opts)
    }

    if (isBundledOrTypescriptPlugin(pluginFn)) {
      pluginFn = pluginFn.default
    }

    if (pluginOpts.addSource) {
      // this Symbol is processed by the `onRegister` hook if necessary
      pluginFn[kSourceRegister] = getSource()[0]
    }
    return originalRegister.call(this, pluginFn, opts)
  }

  // *** routes
  ;[
    'delete',
    'get',
    'head',
    'patch',
    'post',
    'put',
    'options',
    'all'
  ].forEach(shortcut => {
    const originalMethod = instance[shortcut]
    instance[shortcut] = function wrapRoute (url, opts, handler) {
      if (pluginOpts.addSource) {
        // this Symbol is processed by the `onRoute` hook
        getRouteHandler(url, opts, handler)[kSourceRoute] = getSource()[0]
      }
      return originalMethod.call(this, url, opts, handler)
    }
  })

  const originalRoute = instance.route
  instance.route = function wrapRoute (routeOpts) {
    if (pluginOpts.addSource) {
      // this Symbol is processed by the `onRoute` hook
      routeOpts.handler[kSourceRoute] = getSource()[0]
    }
    return originalRoute.call(this, routeOpts)
  }

  // *** hooks
  const originalHook = instance.addHook
  instance.addHook = function wrapAddHook (name, hook) {
    const hookNode = getHookNode(hook)
    if (pluginOpts.addSource) {
      hookNode.source = getSource()[0]
    }
    this[kStructure].hooks[name].push(hookNode)
    return originalHook.call(this, name, hook)
  }
}

// From https://github.com/fastify/avvio/blob/a153be8358ece6a1ed970d0bee2c28a8230175b9/lib/is-bundled-or-typescript-plugin.js#L13-L19
function isBundledOrTypescriptPlugin (maybeBundledOrTypescriptPlugin) {
  return (
    maybeBundledOrTypescriptPlugin !== null &&
    typeof maybeBundledOrTypescriptPlugin === 'object' &&
    typeof maybeBundledOrTypescriptPlugin.default === 'function'
  )
}

// From https://github.com/fastify/avvio/blob/a153be8358ece6a1ed970d0bee2c28a8230175b9/lib/is-promise-like.js#L7-L13
function isPromiseLike (maybePromiseLike) {
  return (
    maybePromiseLike !== null &&
    typeof maybePromiseLike === 'object' &&
    typeof maybePromiseLike.then === 'function'
  )
}

function wrapDecorator (instance, type, { addSource, onDecorateDefinition }) {
  const originalDecorate = instance[type]
  instance[type] = function wrapDecorate (name, value) {
    const decoratorNode = Object.assign(getDecoratorNode(name, value), onDecorateDefinition?.(type, name, value))
    if (addSource) {
      decoratorNode.source = getSource()[0]
    }
    this[kStructure].decorators[type].push(decoratorNode)
    return originalDecorate.call(this, name, value)
  }
}

function getRouteHandler (url, options, handler) {
  if (!handler && typeof options === 'function') {
    handler = options
  }
  return handler || (options && options.handler)
}

function getJsonOverview (request, reply) {
  return this.overview()
}

const plugin = fp(fastifyOverview, {
  name: 'fastify-overview',
  fastify: '^4.23.x'
})

module.exports = plugin
module.exports.default = plugin
module.exports.fastifyOverview = plugin
