'use strict'
const RPC = require('socket.io-rpc')
const _ = require('lodash')
// const debug = require('debug')('moonridge:server')
// 
const MRModel = require('./mr-server-model')
const exposeMethods = require('./mr-rpc-methods')
const debug = require('debug')('moonridge:main')
var userModel
var moonridgeSingleton

const baucis = require('./utils/baucis')

const models = {}
const mongoose = require('mongoose')
const defaultOpts = {
  server: {
    socketOptions: { keepAlive: 1 }
  },
  replset: {
    socketOptions: { keepAlive: 1 }
  }
}

/**
 * @param {String} connString to mongoDB
 * @param {Object} opts connection options
 * @returns {{model: regNewModel, userModel: registerUserModel, authUser: authUser, bootstrap: createServer}} moonridge
 * instance which allows to register models and bootstrap itself
 */
function connect (connString, opts) {
  _.merge(defaultOpts, opts)
  mongoose.connect(connString, defaultOpts, function (err) {
    if (err) {
      throw err
    } else {
      console.log(`connected to mongo ${connString} succesfully`)
    }
  })
  mongoose.connection.on('error', function (err) {
    console.error('MongoDB error: %s', err)
  })
}
/**
 * @param {String} name
 * @param {Object} schema
 * @param {Object} opts
 * @param {Function} [opts.checkPermission] function which should return true/false depending if the connected socket has/hasn't priviliges
 * @param {Object} [opts.permissions] with 4 properties: 'C', 'R','U', 'D' which each represents one type of operation,
 *                                  values should be numbers indicating which level of privilige is needed

 * @returns {MRModel}
 */
function regNewModel (name, schema, opts) {
  var model = MRModel.apply(moonridgeSingleton, arguments);

  var discriminatorFunction = model.discriminator.bind(model);
  model.discriminator = function (name, schema) {

    let discriminatorModel = null;
    let newDocs = new Set();
    schema.pre('save', function (next) {
      if (this.isNew) {
        newDocs.add(this._id)
        if (opts.onExistence) {
          return Promise.resolve(opts.onExistence.call(discriminatorModel, this)).then(() => {
            next();
          }, next);
        }
      }
      next();
    });

    // Hook `save` post method called after creation/update
    schema.post('save', function postSave (doc) {
      if (newDocs.has(doc._id)) {
        newDocs.delete(doc._id);
        discriminatorModel.emit('create', doc);
      } else {
        discriminatorModel.emit('update', doc);
      }
      return true;
    });

    schema.post('remove', function postRemove (doc) {
      discriminatorModel.emit('remove', doc);
    });

    discriminatorModel = discriminatorFunction(name, schema);
    let exposeCallback = exposeMethods(discriminatorModel, schema, {})
    _.assign(discriminatorModel, {
      _exposeCallback: exposeCallback
    });
    models[name] = discriminatorModel;
    return discriminatorModel;
  };

  models[name] = model
  return model
}

/**
 *
 * @param schemaExtend
 * @param {Object} opts
 * @returns {MRModel}
 */
function registerUserModel (schemaExtend, opts) {
  if (userModel) {    // if it was already assigned, we throw
    throw new Error('There can only be one user model and it was already registered')
  }

  var userSchema = require('./utils/user-model-base')
  _.extend(userSchema, schemaExtend)
  userModel = MRModel.call(moonridgeSingleton, 'user', userSchema, opts)
  models['user'] = userModel
  return userModel
}

/**
 * Shares the same signature as express.js listen method, because it passes arguments to it
 * @param {Number} port
 * @param {String} [hostname]
 * @param {Function} [Callback]
 * @returns {{rpcNsp: (Emitter), io: {Object}, server: http.Server}}
 */
function bootstrap () {
  var server = RPC.apply(null, arguments)
  var io = server.io

  var allQueries = []

  Object.keys(models).forEach(function (modelName) {
    var model = models[modelName]
    model._exposeCallback(server)
  })

  io.use(function (socket, next) {
    const registeredLQs = {}
    socket.moonridge = {
      registeredLQs: registeredLQs,
      user: {privilege_level: 0}
    } // default privilege level for any connected client

    socket.on('disconnect', function () {
      // clearing out liveQueries listeners
      debug(socket.id, ' socket disconnected, cleaning up LQ listeners')
      for (var LQId in registeredLQs) {
        var LQ = registeredLQs[LQId]
        LQ.removeListener(socket)
      }
    })

    next()
  })

  server.expose({
    MR: {
      getModels: function () {
        return Object.keys(models)
      },
      deAuthorize: function () {
        this.moonridge.user = {privilege_level: 0}	// for logging users out
      }
    }
  })

  if (process.env.MOONRIDGE_HEALTH === '1') {
    // this reveals any data that you use in queries to the public, so it should not be used in production when dealing with sensitive data

    server.expose({
      MR: {
        getHealth: function () {
          var allModels = {}
          var index = allQueries.length
          while (index--) {
            var modelQueriesForSerialization = {}
            var model = allQueries[index]
            for (var LQ in model.queries) {
              modelQueriesForSerialization[LQ] = Object.keys(model.queries[LQ].listeners).length
            }
            allModels[model.modelName] = modelQueriesForSerialization
          }
          return {
            pid: process.pid,
            memory: process.memoryUsage(),
            uptime: process.uptime(),   // in seconds
            liveQueries: allModels  // key is LQ.clientQuery and value is number of listening clients
          }
        }
      }
    })
  }

  return server
}

moonridgeSingleton = {
  model: regNewModel,
  userModel: registerUserModel,
  bootstrap: bootstrap,
  mongoose: mongoose,
  models: models,
  connect: connect,
  baucis: baucis
}

module.exports = moonridgeSingleton
