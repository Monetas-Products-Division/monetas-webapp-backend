var path = require('path');
var childProcess = require('child_process');

var mongoose = require('mongoose'),
  Schema = mongoose.Schema,
  bcrypt = require('bcryptjs'),
  SALT_WORK_FACTOR = 10,
  // max of 5 attempts, resulting in a 2 hour lock
  MAX_LOGIN_ATTEMPTS = 5,
  LOCK_TIME = 2 * 60 * 60 * 1000;

var UserSchema = new Schema({
  username: { type: String, required: true, index: { unique: true } },
  password: { type: String, required: true },
  from: String,
  deviceId: String,
  loginAttempts: { type: Number, required: true, default: 0 },
  lockUntil: { type: Number },
  wallet: Schema.Types.Mixed,
  units: [Schema.Types.Mixed],
  info: Schema.Types.Mixed,
  createdAt: { type: Date },
  updatedAt: { type: Date }
});

UserSchema.virtual('isLocked').get(function() {
  // check for a future lockUntil timestamp
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

UserSchema.pre('save', function(next) {
  var user = this;

  var now = new Date();
  user.updatedAt = now;
  if ( !user.createdAt ) {
    user.createdAt = now;
  }

  // only hash the password if it has been modified (or is new)
  if (!user.isModified('password')) return next();

  // generate a salt
  bcrypt.genSalt(SALT_WORK_FACTOR, function(err, salt) {
    if (err) return next(err);

    // hash the password using our new salt
    bcrypt.hash(user.password, salt, function (err, hash) {
      if (err) return next(err);

      // set the hashed password back on our user document
      user.password = hash;
      next();
    });
  });
});

UserSchema.methods.comparePassword = function(candidatePassword, cb) {
  bcrypt.compare(candidatePassword, this.password, function(err, isMatch) {
    if (err) return cb(err);
    cb(null, isMatch);
  });
};

UserSchema.methods.incLoginAttempts = function(cb) {
  // if we have a previous lock that has expired, restart at 1
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.update({
      $set: { loginAttempts: 1 },
      $unset: { lockUntil: 1 }
    }, cb);
  }
  // otherwise we're incrementing
  var updates = { $inc: { loginAttempts: 1 } };
  // lock the account if we've reached max attempts and it's not locked already
  if (this.loginAttempts + 1 >= MAX_LOGIN_ATTEMPTS && !this.isLocked) {
    updates.$set = { lockUntil: Date.now() + LOCK_TIME };
  }
  return this.update(updates, cb);
};

// expose enum on the model, and provide an internal convenience reference 
var reasons = UserSchema.statics.failedLogin = {
  NOT_FOUND: 0,
  PASSWORD_INCORRECT: 1,
  MAX_ATTEMPTS: 2
};

UserSchema.statics.getAuthenticated = function(username, password, cb) {
  this.findOne({ username: username }, function(err, user) {
    if (err) return cb(err);

    // make sure the user exists
    if (!user) {
      return cb(null, null, reasons.NOT_FOUND);
    }

    // check if the account is currently locked
    if (user.isLocked) {
      // just increment login attempts if account is already locked
      return user.incLoginAttempts(function(err) {
        if (err) return cb(err);
        return cb(null, null, reasons.MAX_ATTEMPTS);
      });
    }

    // test for a matching password
    user.comparePassword(password, function(err, isMatch) {
      if (err) return cb(err);

      // check if the password was a match
      if (isMatch) {
        // if there's no lock or failed attempts, just return the user
        if (!user.loginAttempts && !user.lockUntil) return cb(null, user);
        // reset attempts and lock info
        var updates = {
          $set: { loginAttempts: 0 },
          $unset: { lockUntil: 1 }
        };
        return user.update(updates, function(err) {
          if (err) return cb(err);
          return cb(null, user);
        });
      }

      // password is incorrect, so increment login attempts before responding
      user.incLoginAttempts(function(err) {
        if (err) return cb(err);
        return cb(null, null, reasons.PASSWORD_INCORRECT);
      });
    });
  });
};

UserSchema.statics.createNewAccount = function(newUser, callback) {
  var _this = this;
  createNewWallet(function(err, wallet) {
    console.log('> wallet: ', err, wallet);
    if (err || !wallet) {
      callback({error: 'A wallet couldn\'t be created'});
      return;
    };

    newUser.wallet = wallet;

    // get nym-id and save it into db record
    var GoatD = new (require('utils/goatd'))(wallet);
    GoatD.call({action: 'nym-id'}, function (err, response, body) {
      console.log('> nym-id: ', err, body);
      if (err || response.statusCode !== 200) {
        callback({error: err});
        return;
      };
      
      newUser.wallet.nym_id = body.trim().replace(/\"/g,'');

      // get allowed units for user's wallet
      GoatD.call({action: 'units'}, function (err, response, body) {
        if (err || response.statusCode !== 200) {
          callback({error: err});
          return;
        };

        var units = JSON.parse(body);
        newUser.units = [];
        for (var id in units) {
          newUser.units.push({
            code: units[id].code,
            id: id,
            name: units[id].name
          });
        };

        // save user to database
        _this.create(newUser, function(err, result) {
          if (err) {
            callback({error: err});
            return;
          };

          callback(null, result);
        });
      });
    });
  });
};

module.exports = mongoose.model('User', UserSchema);

function createNewWallet(cb) {
  childProcess.execFile('newwallet', [''], function(err, stdout, stderr) {
    var wallet = null;
    if (!err) {
      wallet = {
        db_schema: stdout.match(/DB schema:(.*)\n/)[1].trim(),
        service: stdout.match(/Wallet service:(.*)\n/)[1].trim(),
        ident: stdout.match(/Wallet ident:(.*)\n/)[1].trim(),
        port: stdout.match(/Wallet port:(.*)\n/)[1].trim()
      };
    };
    cb(err, wallet);
  });
};

