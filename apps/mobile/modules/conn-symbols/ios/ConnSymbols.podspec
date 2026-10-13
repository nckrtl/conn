Pod::Spec.new do |s|
  s.name           = 'ConnSymbols'
  s.version        = '1.0.0'
  s.summary        = "Conn's Phosphor icons in place of SF Symbols."
  s.description    = 'Custom symbols drawn from Phosphor, returned for the SF Symbol names Conn maps.'
  s.author         = 'Conn'
  s.homepage       = 'https://github.com/nckrtl/conn'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.swift'
  s.resource_bundles = { 'ConnSymbols' => ['ConnSymbols.xcassets'] }
end
