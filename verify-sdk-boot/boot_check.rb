# frozen_string_literal: true
# Boot-check for sdk-ruby. See run.sh for context.

def fail_check(msg)
  warn "FAIL sdk-ruby: #{msg}"
  exit 1
end

fixture = ENV['QFG_BOOT_CHECK_FIXTURE_HOME']
fail_check 'QFG_BOOT_CHECK_FIXTURE_HOME unset' if fixture.nil? || fixture.empty?

# Dir.home reads $HOME first on Unix; point it at the fixture in-process
# so sdk-ruby's loader finds the synthetic tokens.json without disturbing
# the outer shell's HOME.
ENV['HOME'] = fixture

if ENV.fetch('QUONFIG_BACKEND_SDK_KEY', '') != ''
  fail_check 'QUONFIG_BACKEND_SDK_KEY must be unset — boot-check exists to prove the SDK boots without it'
end

datadir = ENV['QFG_BOOT_CHECK_DATADIR']
expected_email = ENV['QFG_BOOT_CHECK_EXPECTED_EMAIL']
expected_key = ENV['QFG_BOOT_CHECK_EXPECTED_KEY']
expected_value = ENV['QFG_BOOT_CHECK_EXPECTED_VALUE']
[datadir, expected_email, expected_key, expected_value].each_with_index do |v, i|
  fail_check "missing QFG_BOOT_CHECK_* env var (index #{i})" if v.nil? || v.empty?
end

$LOAD_PATH.unshift(File.expand_path('../../sdk-ruby/lib', __dir__))
begin
  require 'quonfig'
rescue LoadError => e
  fail_check "require 'quonfig' failed: #{e.class}: #{e.message}"
end

dev_ctx = Quonfig::DevContext.load_quonfig_user_context
fail_check 'dev_context loader returned nil — synthetic tokens.json not picked up' if dev_ctx.nil?
actual_email = dev_ctx.dig('quonfig-user', 'email')
unless actual_email == expected_email
  fail_check "loader returned quonfig-user.email=#{actual_email.inspect}, expected #{expected_email.inspect}"
end

begin
  opts = Quonfig::Options.new(
    datadir: datadir,
    environment: 'Production',
    enable_quonfig_user_context: true,
    collect_evaluation_summaries: false
  )
  client = Quonfig::Client.new(opts)
rescue StandardError => e
  fail_check "Quonfig::Client.new raised without sdk_key: #{e.class}: #{e.message}"
end

begin
  value = client.get_string(expected_key, default: '__BOOT_CHECK_DEFAULT__')
rescue StandardError => e
  fail_check "client.get_string raised: #{e.class}: #{e.message}"
end

unless value == expected_value
  fail_check "client.get_string(#{expected_key.inspect}) returned #{value.inspect}, expected #{expected_value.inspect}"
end

puts "OK sdk-ruby: constructed without sdk_key, dev_context email=#{expected_email}, " \
     "get_string(#{expected_key.inspect})=#{value.inspect}"
