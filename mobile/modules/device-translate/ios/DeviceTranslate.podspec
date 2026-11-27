Pod::Spec.new do |s|
  s.name           = 'DeviceTranslate'
  s.version        = '1.0.0'
  s.summary        = 'On-device translation with Google ML Kit'
  s.description    = 'Free, offline translation; language models are downloaded on demand.'
  s.license        = 'MIT'
  s.author         = ''
  s.homepage       = 'https://github.com/moocky/test-repo'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'GoogleMLKit/Translate'
  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
