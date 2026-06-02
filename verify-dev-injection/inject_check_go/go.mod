module github.com/quonfig/verify-dev-injection-go

go 1.23

require github.com/quonfig/sdk-go v0.0.0

require (
	github.com/fsnotify/fsnotify v1.10.1 // indirect
	github.com/spaolacci/murmur3 v1.1.0 // indirect
	golang.org/x/sys v0.13.0 // indirect
)

replace github.com/quonfig/sdk-go => ../../../sdk-go
