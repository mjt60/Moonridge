var mongooseMethodValidations = require('moonridge-client/lib/moonridge-method-validations')

var maxQueryLength = 70    // hardcoded max query length
var qMethodsEnum = []

for (var method in mongooseMethodValidations) {
  qMethodsEnum.push(method)
}

var callJustOnce = [
  'findOne',
  'select',
  'count',
  'sort',
  'limit',
  'skip'
]

/**
 * @param {Mongoose.Model} model
 * @param {Array<Object>} clientQuery received JSON deserialized
 * @param {Boolean} isLive true for liveQueries
 * @returns {MRQuery|Error}
 */
module.exports = function MRQuery (model, clientQuery, isLive) {
  var query = model.find()

  // query option object,where we index by method, not by invocation order, useful later when we reexecute the query
  var opts = {populate: []}

  if (!Array.isArray(clientQuery)) {
    throw new TypeError('Query must be an array')
  }
  if (clientQuery.length > maxQueryLength) {
    throw new Error('Maximum query length of the query is bigger than allowed')
  }

  var ind = 0
  while (clientQuery[ind]) {
    var methodName = clientQuery[ind].mN   // short for methodName
    if (qMethodsEnum.indexOf(methodName) !== -1) {
      var args = clientQuery[ind].args

      if (Array.isArray(args)) {	// if it is one of SAA, then we won't call it with apply
        var validationResult = mongooseMethodValidations[methodName](args)
        if (validationResult instanceof Error) {
          throw validationResult
        }

        if (callJustOnce.indexOf(methodName) !== -1) {
          if (methodName === 'sort' && opts.count) {
            // doesn't really makes sense to make both at once
            throw new Error('Mongoose does not support sort and count in one query')
          }

          if (opts[methodName]) {
            throw new Error(methodName + ' method can be called just once per query')
          } else {
            opts[methodName] = args // we shall add it to the options, this object will be used when reiterating on LQ
          }
        } else if (methodName === 'populate') {
          opts.populate.push(args)
        }

        if (methodName === 'count' && isLive) {
          opts.count = true
          break
        }
        query = query[methodName].apply(query, args)
      } else {
        throw new TypeError('Method arguments for "' + methodName + '" must be array, query builder cannot parse this')
      }
    } else {
      throw new Error('Method "' + methodName + '" is not a valid query method.')
    }
    ind += 1
  }

  // query.lean(true)

  return {opts: opts, mQuery: query}
}
