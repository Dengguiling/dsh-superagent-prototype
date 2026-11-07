# ---------------------------------------------------------------------------
# Redmine bootstrap, executed by `rails runner` inside the redmine image
# (see docker-compose.yml -> redmine-init).
#
#   * enables the REST web services (Administration > Settings > Authentication)
#   * loads the default configuration data on a fresh database
#   * keeps the sessions long, so a person stays signed in while the demo runs
#   * creates the three accounts of the company and pins their API keys:
#       admin  the system manager: the highest rights, kept out of the tests
#       lead   the leader: the project manager who assigns the work
#       dev    the developer: the account the superagent binds to; there is no
#              account of the agent's own.  Older revisions created it as
#              `agent`; init.rb renames it once, keeping its user id and key.
#
# Everything is idempotent: running it again only re-applies the values.
# ---------------------------------------------------------------------------

def log(msg)
  puts "[redmine-init] #{msg}"
end

# --- default configuration data --------------------------------------------
# The official docker image only runs `rake db:migrate`, so the default
# trackers / statuses / priorities / roles are missing.  Load them here,
# otherwise no issue can be created.
begin
  Redmine::DefaultData::Loader.load('en')
  log 'default configuration data loaded'
rescue Redmine::DefaultData::DataAlreadyLoaded => e
  log "default configuration data already present (#{e.message})"
rescue => e
  log "ERROR: could not load the default configuration data: #{e.message}"
  exit 1
end

# --- helpers ---------------------------------------------------------------
def save_user!(user, login, firstname, lastname, mail, password, admin)
  user.login = login
  user.firstname = firstname
  user.lastname = lastname
  user.mail = mail
  user.password = password
  user.password_confirmation = password
  user.admin = admin
  user.status = User::STATUS_ACTIVE
  user.must_change_passwd = false
  unless user.save
    log "ERROR: could not save user #{login}: #{user.errors.full_messages.join(', ')}"
    exit 1
  end
  user
end

def ensure_user(login, firstname, lastname, mail, password, admin)
  user = User.find_by(login: login)
  if user.nil?
    user = User.new
    log "created user #{login}"
  else
    log "user #{login} already exists"
  end
  save_user!(user, login, firstname, lastname, mail, password, admin)
end

def pin_api_key(user, value)
  # Redmine 4.2 exposes the api token as `user.api_token` (has_one).
  token = user.api_token
  token = Token.create!(:user_id => user.id, :action => 'api') if token.nil?
  token.value = value
  token.save!
  log "api key of #{user.login} = #{token.value}"
end

# --- REST web services ------------------------------------------------------
Setting.rest_api_enabled = '1'
log "rest_api_enabled = #{Setting.rest_api_enabled}"

# --- sessions that do not expire while the demo runs ------------------------
# A person signs in through the sign-in page; the session has to survive the
# time between two looks at the task system.
Setting.session_timeout = 60 * 24 * 30    # 30 days of inactivity
Setting.session_expiration = 0 if Setting.respond_to?(:session_expiration=)  # and no absolute end
log "session_timeout = #{Setting.session_timeout} minutes"

# --- administrator = the system manager -------------------------------------
admin_login     = ENV.fetch('REDMINE_ADMIN_LOGIN', 'admin')
admin_password  = ENV.fetch('REDMINE_ADMIN_PASSWORD', 'admin12345')
admin_api_key   = ENV.fetch('REDMINE_ADMIN_API_KEY', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4')
admin_firstname = ENV.fetch('REDMINE_ADMIN_FIRSTNAME', 'System')
admin_lastname  = ENV.fetch('REDMINE_ADMIN_LASTNAME', 'Administrator')
admin_mail      = ENV.fetch('REDMINE_ADMIN_MAIL', 'admin@example.com')

admin = ensure_user(admin_login, admin_firstname, admin_lastname, admin_mail, admin_password, true)
pin_api_key(admin, admin_api_key)
log "administrator #{admin.login} is #{admin.name} <#{admin.mail}>"
log "WARN: the #{admin.login} account is an administrator; this is a mock environment" unless admin.admin

# --- leader = the project manager -------------------------------------------
lead_login     = ENV.fetch('REDMINE_LEAD_LOGIN', 'lead')
lead_password  = ENV.fetch('REDMINE_LEAD_PASSWORD', 'lead12345')
lead_api_key   = ENV.fetch('REDMINE_LEAD_API_KEY', '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d')
lead_firstname = ENV.fetch('REDMINE_LEAD_FIRSTNAME', 'Wang')
lead_lastname  = ENV.fetch('REDMINE_LEAD_LASTNAME', 'Lei')
lead_mail      = ENV.fetch('REDMINE_LEAD_MAIL', 'lead@example.com')

lead = ensure_user(lead_login, lead_firstname, lead_lastname, lead_mail, lead_password, false)
pin_api_key(lead, lead_api_key)
log "leader #{lead.login} is #{lead.name} <#{lead.mail}> (user ##{lead.id})"

# --- developer = the bound account ----------------------------------------
dev_login    = ENV.fetch('REDMINE_DEV_LOGIN', 'dev')
legacy_login = ENV.fetch('REDMINE_LEGACY_DEV_LOGIN', 'agent')
dev_password = ENV.fetch('REDMINE_DEV_PASSWORD', 'agent12345')
dev_api_key  = ENV.fetch('REDMINE_DEV_API_KEY', '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c')
dev_firstname = ENV.fetch('REDMINE_DEV_FIRSTNAME', 'Zhang')
dev_lastname  = ENV.fetch('REDMINE_DEV_LASTNAME', 'Wei')
dev_mail      = ENV.fetch('REDMINE_DEV_MAIL', 'dev@example.com')

dev = User.find_by(login: dev_login)
if dev.nil?
  legacy = User.find_by(login: legacy_login)
  if legacy
    log "renaming the Redmine account '#{legacy_login}' to '#{dev_login}' (user ##{legacy.id}), the user id and the api key are kept"
    dev = legacy
  else
    log "creating the Redmine account '#{dev_login}'"
    dev = User.new
  end
else
  log "developer account #{dev_login} already exists"
  leftover = User.find_by(login: legacy_login)
  log "WARN: both '#{dev_login}' and '#{legacy_login}' exist; the old account is left untouched" if leftover
end

dev = save_user!(dev, dev_login, dev_firstname, dev_lastname, dev_mail, dev_password, false)
pin_api_key(dev, dev_api_key)
log "developer #{dev.login} is #{dev.name} <#{dev.mail}> (user ##{dev.id})"

log 'redmine bootstrap finished'
# The runner leaves the connection pool open; the container has to end on its own.
exit 0
