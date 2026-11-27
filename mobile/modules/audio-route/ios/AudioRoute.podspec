Pod::Spec.new do |s|
  s.name           = 'AudioRoute'
  s.version        = '1.0.0'
  s.summary        = 'Headphone / audio route detection'
  s.description    = 'Reports whether audio output is routed to headphones.'
  s.license        = 'MIT'
  s.author         = ''
  s.homepage       = 'https://github.com/moocky/test-repo'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
