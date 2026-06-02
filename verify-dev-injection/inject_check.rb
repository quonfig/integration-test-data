# frozen_string_literal: true
# Injection-check for sdk-ruby. See run.sh for context.
#
# Boots a DEFAULT-config datadir client (NO enable_quonfig_user_context, NO
# QUONFIG_DEV_CONTEXT) and asserts the dev-override flag resolves purely from
# token-file injection.

def fail_check(msg)
  warn "FAIL sdk-ruby: #{msg}"
  exit 1
end

fixture = ENV['QFG_INJECT_FIXTURE_HOME']
fail_check 'QFG_INJECT_FIXTURE_HOME unset' if fixture.nil? || fixture.empty?

# Dir.home reads $HOME first on Unix; point it at the fixture so the loader
# finds the synthetic tokens.json (or, in the no-token phase, nothing).
ENV['HOME'] = fixture
# The default must hold without the env opt-in.
ENV.delete('QUONFIG_DEV_CONTEXT')

datadir = ENV['QFG_INJECT_DATADIR']
key = ENV['QFG_INJECT_KEY']
expected = ENV['QFG_INJECT_EXPECTED'] == 'true'
fail_check 'missing QFG_INJECT_* env vars' if datadir.nil? || datadir.empty? || key.nil? || key.empty?

$LOAD_PATH.unshift(File.expand_path('../../sdk-ruby/lib', __dir__))
begin
  require 'quonfig'
rescue LoadError => e
  fail_check "require 'quonfig' failed: #{e.class}: #{e.message}"
end

begin
  # DEFAULT config — deliberately NO enable_quonfig_user_context.
  opts = Quonfig::Options.new(
    datadir: datadir,
    environment: 'Production',
    collect_evaluation_summaries: false
  )
  client = Quonfig::Client.new(opts)
rescue StandardError => e
  fail_check "Quonfig::Client.new raised: #{e.class}: #{e.message}"
end

begin
  value = client.get_bool(key, default: false)
rescue StandardError => e
  fail_check "client.get_bool raised: #{e.class}: #{e.message}"
end

unless value == expected
  phase = expected ? 'token-present' : 'no-token'
  fail_check "client.get_bool(#{key.inspect}) = #{value.inspect}, expected #{expected} (phase: #{phase}, HOME=#{fixture})"
end

phase = expected ? 'token-present' : 'no-token'
puts "OK sdk-ruby: #{phase} -> get_bool(#{key.inspect})=#{value}"
