var locals = require('./localVariables.json')

var MR = require('../../moonridge')
var staticMW = require('express').static

MR.connect(locals.connString)
var mongoose = MR.mongoose
mongoose.set('debug', true)
var dbInit = require('./db-init')
dbInit(MR)
var app = require('express')()
var server = require('http').Server(app)
var rpcServer = MR.bootstrap(server)
app.use('/api', MR.baucis())

app.use(require('morgan')('dev'))

app.use(staticMW('./test/e2e-smoketest/'))
app.use(staticMW('./test/e2e-smoketest/angular'))
app.use(staticMW('./test/e2e-smoketest/aurelia'))
app.use(staticMW('./test/e2e-smoketest/react'))

var assignUserToASocket = function (socket) {
  return function (user) {
    if (user) {
      console.log('Authenticated user: ', user)
      socket.moonridge.user = user
    } else {
      console.warn('did not find such user')
    }
    return user
  }
}

rpcServer.io.use(function (socket, next) { // example of initial authorization
  // it is useful only for apps which require user authentication by default
  var authObj = socket.handshake.query
  var userName = authObj.nick

  console.log('user wants to authorize: ' + userName)
  console.log('socket: ', socket.handshake.query)
  console.log('socket.id: ' + socket.id)
  var userModel = mongoose.model('user')
  userModel.findOne({name: userName}).exec().then(function (user) {
    assignUserToASocket(socket)(user)
    next()
  }, function (err) {
    console.log('auth error ' + err)
    next(err)
  })
})

rpcServer.expose({
  MR: {
    authorize: function (data) { // example of a later authorization, typical for any public facing apps
      var socket = this
      var userModel = mongoose.model('user')
      console.log('data', data)

      return userModel.findOne({name: data.nick}).exec().then(assignUserToASocket(socket), function (err) {
        console.log('auth error ' + err)
      })
    }
  }
})
server.listen(8080)

module.exports = MR
